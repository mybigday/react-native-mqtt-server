import type { QoS } from 'mqtt-packet';
import type {
  IPingreqPacket,
  IConnectPacket,
  IPublishPacket,
  ISubscribePacket,
  IUnsubscribePacket,
} from 'mqtt-packet';
import type { Buffer } from 'buffer';
import EventEmitter from 'eventemitter3';
import { Server, Client } from './';

export interface Options {
  authenticate?: (user?: string, pass?: Buffer) => Promise<boolean> | boolean;
  retryInterval?: number;
}

export interface MQClientSession {
  storeMessage?: {
    messageId?: number;
    topic: string;
    payload: string | Buffer;
  };
  nextId: number;
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
  protected authenticate?: (
    user?: string,
    pass?: Buffer
  ) => Promise<boolean> | boolean;

  constructor(options: Options = {}) {
    super();
    this.server = new Server();
    this.authenticate = options.authenticate;
    this.retryInterval = options.retryInterval ?? 3000;
    this.clients = {};
    this.server.on('connection', this.handleClient.bind(this));
    this.sessions = {};
  }

  start(port?: number) {
    this.server.listen({ port: port ?? 1883, host: '0.0.0.0' });
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
      if (pass) {
        client.connack({ returnCode: 0, reasonCode: 0 });
      } else {
        client.connack({ returnCode: 5, reasonCode: 135 });
      }
      id = packet.clientId;
      this.clients[id] = client;
      if (packet.clean) {
        this.sessions[id] = { nextId: 0, subs: {}, alive: true };
      } else {
        this.sessions[id] ??= { nextId: 0, subs: {}, alive: true };
        this.sessions[id]!.alive = true;
      }
      session = this.sessions[id];
    });
    client.on('publish', async (packet: IPublishPacket) => {
      if (!session || session?.storeMessage) return;
      switch (packet.qos) {
        case 0:
          this.processMessage(packet.messageId, packet.topic, packet.payload);
          break;
        case 1:
          this.processMessage(packet.messageId, packet.topic, packet.payload);
          client.puback({
            messageId: packet.messageId,
          });
          break;
        case 2:
          session!.storeMessage = {
            messageId: packet.messageId,
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
      if (!session?.storeMessage) return;
      this.processMessage(
        session!.storeMessage!.messageId,
        session!.storeMessage!.topic,
        session!.storeMessage!.payload
      );
      delete session?.storeMessage;
      client.pubcomp({
        messageId: packet.messageId,
      });
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
    for (const cId in this.sessions) {
      for (const rule in this.sessions[cId]!.subs) {
        if (matchRule(rule, topic)) {
          const qos = this.sessions[cId]!.subs[rule] ?? 0;
          this.doTask(cId, messageId ?? 0, topic, payload, qos);
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
