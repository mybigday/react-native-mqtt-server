import type { Packet, QoS } from 'mqtt-packet';
import type { Buffer } from 'buffer';
import EventEmitter from 'eventemitter3';
import { Server, Client } from './';

export interface Options {
  authenticate?: (user?: string, pass?: Buffer) => Promise<boolean> | boolean;
  retryInterval?: number;
}

export interface MQClientSession {
  storeMessage?: { topic: string; payload: string | Buffer };
  nextId: number;
  subs: {[rule: string]: QoS}
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

class Message {
  protected topic: string;
  protected payload: string | Buffer;
  protected expireTime: number | undefined;

  constructor(topic: string, payload: string | Buffer, retainTime?: number | undefined) {
    this.topic = topic;
    this.payload = payload;
    this.expireTime = retainTime && Date.now() + retainTime;
  }

  get expired() {
    return this.expireTime && Date.now() >= this.expireTime;
  }

  match(topic: string) {
    return matchRule(topic, this.topic);
  }

  get payload() {
    return this.payload;
  }

  get topic() {
    return this.topic;
  }

  get retain() {
    return !!this.expireTime;
  }
}

export class SimpleMQServer extends EventEmitter {
  protected server: Server;
  protected clients: {[id: string]: Client};
  protected sessions: {[id: string]: MQClientSession};
  protected retryInterval: number;
  protected messages: Message[];

  constructor(options?: Options = {}) {
    super();
    this.server = new Server();
    this.authenticate = options?.authenticate;
    this.retryInterval = options?.retryInterval ?? 3000;
    this.clients = {};
    this.server.on('connection', this.handleClient.bind(this));
    this.sessions = {};
    this.messages = [];
  }

  start(port?: number) {
    this.server.listen(port ?? 1883);
  }

  handleClient(client: Client) {
    let id: string | undefined;
    let session: ClientState | undefined;
    client.on('close', () => {
      delete this.clients[id];
    });
    client.on('disconnect', async (packet) => {
      client.end();
    });
    client.on('connect', async (packet) => {
      if (verifyId(packet.clientId)) {
        client.connack({ returnCode: 2 });
        return;
      }
      const version = packet.protocolVersion ?? 5;
      client.setProtocolVersion(version);
      const pass = await this.authenticate?.(connPkt.username, connPkt.password) ?? true;
      if (pass) {
        client.connack({ returnCode: 0, reasonCode: 0 })
      } else {
        client.connack({ returnCode: 5, reasonCode: 135 })
      }
      id = packet.clientId;
      this.clients[id] = client;
      if (packet.clean) {
        this.sessions[id] = { nextId: 0, subs: {} };
      } else {
        this.sessions[id] ??= { nextId: 0, subs: {} };
      }
      session = this.sessions[id];
    });
    client.on('publish', async (packet) => {
      if (!session || session?.storeMessage) return;
      switch (packet.qos) {
      case 0:
        this.processMessage(packet.topic, packet.payload);
        break;
      case 1:
        this.processMessage(packet.topic, packet.payload);
        client.puback();
        break;
      case 2:
        session!.storeMessage = {
          topic: packet.topic,
          payload: packet.payload,
        };
        client.pubrec();
        break;
      }
    });
    client.on('pubrel', () => {
      if (!session?.storeMessage) return;
      this.processMessage(
        session!.storeMessage!.topic,
        session!.storeMessage!.payload
      );
      delete session?.storeMessage;
      client.pubcomp();
    });
    client.on('subscribe', (packet) => {
      if (!session) return;
      const granted = packet.subscriptions.map((sub) => {
        session!.subs[sub.topic] = sub.qos;
        return sub.qos;
      });
      client.suback({ granted });
    });
    client.on('unsubscribe', (packet) => {
      client.unsuback(packet);
      server.emit('unsubscribe', client, packet.unsubscriptions);
    });
    client.on('pingreq', () => {
      client.pingresp();
    });
  }

  processMessage(messageId: number, topic: string, payload: string | Buffer) {
    this.emit('message', topic, payload);
    for (const cId in this.sessions) {
      for (const rule in this.sessions[cId]!.subs) {
        if (matchRule(rule, topic)) {
          const qos = this.sessions[cId]!.subs[rule];
          this.doTask(cId, messageId, topic, payload, qos);
          break;
        }
      }
    }
  }

  doTask(cId: string, messageId: number, topic: string, payload: string | Buffer, qos: QoS, dup?: boolean = false) {
    if (!this.sessions[cId]) return;
    this.clients[cId]!.publish({ topic, payload, qos, dup });
    switch (qos) {
    case 1:
      this.clients[cId]!.once('puback', () => {
        clearTimeout(this.sessions[cId]?.retry);
      });
      this.sessions[cId]!.retry = setTimeout(() => {
        this.clients[cId]?.removeAllListeners('puback');
        delete this.sessions[cId]?.['retry'];
        this.doTask(cId, topic, payload, qos, true);
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
        delete this.sessions[cId]?.['retry'];
        this.doTask(cId, topic, payload, qos, true);
      }, this.retryInterval);
      break;
    }
  }
}
