import type { QoS } from 'mqtt-packet';
import type {
  IConnectPacket,
  IPublishPacket,
  IPubackPacket,
  IPubrecPacket,
  IPubcompPacket,
  ISubscribePacket,
  IUnsubscribePacket,
} from 'mqtt-packet';
import type { Buffer } from 'buffer';
import { EventEmitter } from 'tseep';
import { Server, Client } from './';

const TOPIC_PART_LIMIT = 16;

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
  tasks: { [id: number]: ReturnType<typeof setInterval> };
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

const verifyTopic = (topic: string) => {
  if (/^[^#]*(?:\/?#|\/?[^#]*)?$/.test(topic)) {
    return topic.split('/').length <= TOPIC_PART_LIMIT;
  } else {
    return false;
  }
};

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
    this.server.on('error', (err) => {
      this.emit('error', err);
    });
    this.server.on('close', () => {
      this.emit('close');
    });
    this.server.on('listening', () => {
      this.emit('listening');
    });
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
      this.emit('clientDisconnected', id);
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
      id = `${packet.username ?? 'anonymous'}-${packet.clientId}`;
      this.clients[id] = client;
      session = this.sessions[id] ??= {
        subs: {},
        alive: true,
        pending: {},
        tasks: {},
      };
      session!.alive = true;
      if (packet.clean) {
        Object.values(session!.tasks).forEach(clearInterval);
        session!.tasks = {};
        session!.subs = {};
        session!.pending = {};
      }
      this.emit('clientConnected', id);
    });
    client.on('publish', async (packet: IPublishPacket) => {
      if (!session) return;
      switch (packet.qos) {
        case 0:
          this.processMessage(packet);
          break;
        case 1:
          client.puback({
            messageId: packet.messageId,
          });
          this.processMessage(packet);
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
      this.processMessage({
        ...message,
        messageId,
      });
    });
    client.on('subscribe', (packet: ISubscribePacket) => {
      if (!session) return;
      const granted: number[] = [];
      for (const sub of packet.subscriptions) {
        if (!verifyTopic(sub.topic)) {
          granted.push(128);
        } else {
          session!.subs[sub.topic] = sub.qos;
          granted.push(sub.qos);
        }
      }
      client.suback({
        messageId: packet.messageId,
        granted,
      });
    });
    client.on('unsubscribe', (packet: IUnsubscribePacket) => {
      if (!session) return;
      if (Object.keys(session!.subs).length === 0) {
        client.unsuback({
          messageId: packet.messageId,
          reasonCode: 17,
        });
        return;
      }
      const granted: number[] = [];
      for (const topic of packet.unsubscriptions) {
        if (!session!.subs[topic]) {
          granted.push(128);
        } else {
          delete session!.subs[topic];
          granted.push(0);
        }
      }
      client.unsuback({
        messageId: packet.messageId,
        reasonCode: 0,
        granted,
      });
    });
    client.on('pingreq', () => {
      client.pingresp();
    });
    client.on('puback', (packet: IPubackPacket) => {
      const messageId = packet.messageId ? Number(packet.messageId) : -1;
      if (session?.tasks[messageId] !== undefined) {
        clearInterval(session!.tasks[messageId]);
        delete session!.tasks[messageId];
        this.emit('messageSend', id, messageId);
      }
    });
    client.on('pubrec', (packet: IPubrecPacket) => {
      const messageId = packet.messageId ? Number(packet.messageId) : -1;
      if (session?.tasks[messageId] !== undefined) {
        client?.pubrel({ messageId });
      }
    });
    client.on('pubcomp', (packet: IPubcompPacket) => {
      const messageId = packet.messageId ? Number(packet.messageId) : -1;
      if (session?.tasks[messageId] !== undefined) {
        clearInterval(session!.tasks[messageId]);
        delete session!.tasks[messageId];
        this.emit('messageSend', id, messageId);
      }
    });
  }

  protected processMessage(packet: Partial<IPublishPacket>) {
    this.emit('message', packet.topic, packet.payload);
    this.publish(packet.topic!, packet.payload!, packet.messageId);
  }

  publish(
    topic: string,
    payload: string | Buffer,
    messageId: number | undefined
  ): number {
    const id = messageId ?? this.nextId++;
    for (const cId in this.sessions) {
      for (const rule in this.sessions[cId]!.subs) {
        if (matchRule(rule, topic)) {
          const qos = this.sessions[cId]!.subs[rule] ?? 0;
          this.createPubTask(cId, id, topic, payload, qos);
          break;
        }
      }
    }
    return id;
  }

  protected createPubTask(
    cId: string,
    messageId: number,
    topic: string,
    payload: string | Buffer,
    qos: QoS,
    dup: boolean = false
  ) {
    const session = this.sessions[cId];
    if (!session?.alive) return;
    const pubPacket = { messageId, topic, payload, qos, dup };
    const client = this.clients[cId];
    if (qos > 0) {
      session!.tasks[messageId] = setInterval(() => {
        client?.publish(pubPacket);
      }, this.retryInterval);
    }
    client?.publish(pubPacket);
  }
}

export default SimpleMQBroker;
