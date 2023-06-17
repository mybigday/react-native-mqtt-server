import type { QoS } from 'mqtt-packet';
import type {
  IPingreqPacket,
  IConnectPacket,
  IPublishPacket,
  ISubscribePacket,
  IUnsubscribePacket,
} from 'mqtt-packet';
import type { Buffer } from 'buffer';
import { EventEmitter } from 'events';
import { Server, Client } from './';

export interface Options {
  authenticate?: (user?: string, pass?: Buffer) => Promise<boolean> | boolean;
  retryInterval?: number;
  keepalive?: number;
}

interface Message {
  topic: string;
  payload: string | Buffer;
}

export interface MQClientSession {
  pending: { [id: string]: Message };
  subs: { [rule: string]: QoS };
  retry?: ReturnType<typeof setTimeout>;
  alive: boolean;
}

function matchRule(rule: string, topic: string) {
  if (rule === topic) {
    return true;
  }
  const ruleParts = rule.split('/');
  const topicParts = topic.split('/');
  for (let i = 0; i < ruleParts.length; i++) {
    if (ruleParts[i] === '#') {
      return true;
    }
    if (ruleParts[i] !== '+' && ruleParts[i] !== topicParts[i]) {
      return false;
    }
  }
  return ruleParts.length === topicParts.length;
}

export class SimpleMQBroker extends EventEmitter {
  protected server: Server;
  protected clients: { [id: string]: Client };
  protected sessions: { [id: string]: MQClientSession };
  protected retryInterval: number;
  protected keepalive: number;
  protected authenticate?: (
    user?: string,
    pass?: Buffer
  ) => Promise<boolean> | boolean;
  protected nextId: number;

  constructor(options: Options = {}) {
    super();
    this.server = new Server();
    this.authenticate = options.authenticate;
    this.retryInterval = options.retryInterval ?? 3000;
    this.keepalive = options.keepalive ?? 60;
    this.clients = {};
    this.server.on('connection', this.handleClient.bind(this));
    this.server.on('error', this.emit.bind(this, 'error'));
    this.server.on('close', this.emit.bind(this, 'close'));
    this.server.on('listening', this.emit.bind(this, 'listening'));
    this.sessions = {};
    this.nextId = 1000;
  }

  start(port?: number) {
    this.server.listen({ port: port ?? 1883, host: '0.0.0.0' });
  }

  stop() {
    this.server.close();
  }

  protected handleClient(client: Client) {
    let id: string | undefined;
    let session: MQClientSession | undefined;
    client.on('close', () => {
      if (id && session) {
        delete this.clients[id!];
        session!.alive = false;
      }
    });
    client.on('disconnect', () => {
      client.end();
    });
    client.on('connect', async (packet: IConnectPacket) => {
      if (this.sessions[packet.clientId]?.alive) {
        client.connack({ returnCode: 2 });
        return;
      }
      const version = packet.protocolVersion ?? 5;
      client.setProtocolVersion(version);
      const pass =
        (await this.authenticate?.(packet.username, packet.password)) ?? true;
      const sessionPresent = packet.clean
        ? false
        : !!this.sessions[packet.clientId];
      const keepalive = packet.keepalive ?? this.keepalive;
      if (pass) {
        client.connack({
          returnCode: 0,
          reasonCode: 0,
          sessionPresent,
          attributes: {
            serverKeepAlive: keepalive,
          },
        });
        client.setKeepAlive(keepalive);
      } else {
        client.connack({ returnCode: 5, reasonCode: 135 });
      }
      id = packet.clientId;
      this.clients[id] = client;
      session = this.sessions[id] ??= { subs: {}, alive: true, pending: {} };
      session!.alive = true;
      if (packet.clean) {
        session!.subs = {};
        session!.pending = {};
        session!.retry && clearTimeout(session!.retry!);
      }
      this.emit('connect', id);
    });
    client.on('publish', async (packet: IPublishPacket) => {
      if (!session) return;
      switch (packet.qos) {
        case 0:
          this.processMessage(packet.messageId, packet.topic, packet.payload);
          break;
        case 1:
          client.puback({
            messageId: packet.messageId,
          });
          this.processMessage(packet.messageId, packet.topic, packet.payload);
          break;
        case 2:
          session!.pending[packet.messageId!] = {
            topic: packet.topic,
            payload: packet.payload,
          };
          client.pubrec({
            messageId: packet.messageId,
          });
          break;
      }
    });
    client.on('pubrel', (packet) => {
      const { messageId } = packet;
      if (!session?.pending[messageId]) return;
      const message = session!.pending[messageId]!;
      delete session?.pending[messageId];
      client.pubcomp({
        messageId,
      });
      this.processMessage(messageId, message.topic, message.payload);
    });
    client.on('subscribe', (packet: ISubscribePacket) => {
      if (!session) return;
      const granted: QoS[] = [];
      for (const sub of packet.subscriptions) {
        session!.subs[sub.topic] = sub.qos;
        granted.push(sub.qos);
      }
      client.suback({
        messageId: packet.messageId,
        granted,
      });
    });
    client.on('unsubscribe', (packet: IUnsubscribePacket) => {
      if (!session) return;
      for (const topic of packet.unsubscriptions) {
        delete session?.subs[topic];
      }
      client.unsuback({
        messageId: packet.messageId,
        reasonCode: 0,
      });
    });
    client.on('pingreq', (packet: IPingreqPacket) => {
      client.pingresp({
        messageId: packet.messageId,
      });
    });
  }

  protected processMessage(
    messageId: number | undefined,
    topic: string,
    payload: string | Buffer
  ) {
    this.emit('message', topic, payload);
    this.publish(messageId, topic, payload);
  }

  publish(
    messageId: number | undefined,
    topic: string,
    payload: string | Buffer
  ) {
    const id = messageId ?? this.nextId++;
    for (const cId in this.sessions) {
      for (const rule in this.sessions[cId]!.subs) {
        if (matchRule(rule, topic)) {
          const qos = this.sessions[cId]!.subs[rule] ?? 0;
          this.doTask(cId, id, topic, payload, qos);
          break;
        }
      }
    }
  }

  protected doTask(
    cId: string,
    messageId: number,
    topic: string,
    payload: string | Buffer,
    qos: QoS,
    dup: boolean = false
  ) {
    if (!this.sessions[cId]) return;
    this.clients[cId]!.publish({ messageId, topic, payload, qos, dup });
    switch (qos) {
      case 1:
        this.clients[cId]!.once('puback', () => {
          clearTimeout(this.sessions[cId]?.retry);
        });
        this.sessions[cId]!.retry = setTimeout(() => {
          this.clients[cId]?.removeAllListeners('puback');
          delete this.sessions[cId]?.retry;
          this.doTask(cId, messageId, topic, payload, qos, true);
        }, this.retryInterval);
        break;
      case 2:
        this.clients[cId]!.once('pubrec', () => {
          this.clients[cId]!.pubrel();
        });
        this.clients[cId]!.once('pubcomp', () => {
          clearTimeout(this.sessions[cId]?.retry);
        });
        this.sessions[cId]!.retry = setTimeout(() => {
          this.clients[cId]?.removeAllListeners('pubrec');
          this.clients[cId]?.removeAllListeners('pubcomp');
          delete this.sessions[cId]?.retry;
          this.doTask(cId, messageId, topic, payload, qos, true);
        }, this.retryInterval);
        break;
    }
  }
}

export default SimpleMQBroker;
