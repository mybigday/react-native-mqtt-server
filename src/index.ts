import type { Buffer } from 'buffer';
import type { Packet, Parser } from 'mqtt-packet';
import net from 'react-native-tcp-socket';
import mqtt from 'mqtt-packet';
import { EventEmitter } from 'events';

export type Callback = (err?: Error | undefined) => any;

export class Client extends EventEmitter {
  protected socket: net.Socket;
  protected parser: Parser;
  protected _opts: Object | undefined;

  constructor(socket: net.Socket, mqttOptions?: Object) {
    super();
    this._opts = mqttOptions;
    this.socket = socket;
    this.parser = mqtt.parser(this._opts);
    this.parser.on('packet', (packet) => {
      this.emit('data', packet);
      this.emit(packet.cmd, packet);
    });
    this.parser.on('error', this.emit.bind(this, 'error'));
    this.socket.on('data', (data) => {
      this.parser.parse(data! as Buffer);
    });
    this.socket.on('error', this.emit.bind(this, 'error'));
    this.socket.on('close', this.emit.bind(this, 'close'));
  }

  setKeepAlive(keepalive: number) {
    this.socket.setKeepAlive(keepalive > 0, keepalive);
  }

  setProtocolVersion(version: number) {
    this._opts = Object.assign({}, this._opts, { protocolVersion: version });
    this.parser = mqtt.parser(this._opts);
    this.parser.on('packet', (packet) => {
      this.emit('data', packet);
      this.emit(packet.cmd, packet);
    });
    this.parser.on('error', this.emit.bind(this, 'error'));
  }

  write(packet: Packet, cb?: Callback | undefined) {
    this.socket.write(mqtt.generate(packet, this._opts), undefined, cb);
  }

  end() {
    this.socket.end();
  }

  close() {
    this.socket.destroy();
  }

  connect(props?: Object, cb?: Callback | undefined) {
    this.write(Object.assign({ cmd: 'connect' }, props ?? {})! as Packet, cb);
  }

  connack(props?: Object, cb?: Callback | undefined) {
    this.write(Object.assign({ cmd: 'connack' }, props ?? {})! as Packet, cb);
  }

  publish(props?: Object, cb?: Callback | undefined) {
    this.write(Object.assign({ cmd: 'publish' }, props ?? {})! as Packet, cb);
  }

  puback(props?: Object, cb?: Callback | undefined) {
    this.write(Object.assign({ cmd: 'puback' }, props ?? {})! as Packet, cb);
  }

  pubrec(props?: Object, cb?: Callback | undefined) {
    this.write(Object.assign({ cmd: 'pubrec' }, props ?? {})! as Packet, cb);
  }

  pubrel(props?: Object, cb?: Callback | undefined) {
    this.write(Object.assign({ cmd: 'pubrel' }, props ?? {})! as Packet, cb);
  }

  pubcomp(props?: Object, cb?: Callback | undefined) {
    this.write(Object.assign({ cmd: 'pubcomp' }, props ?? {})! as Packet, cb);
  }

  subscribe(props?: Object, cb?: Callback | undefined) {
    this.write(Object.assign({ cmd: 'subscribe' }, props ?? {})! as Packet, cb);
  }

  suback(props?: Object, cb?: Callback | undefined) {
    this.write(Object.assign({ cmd: 'suback' }, props ?? {})! as Packet, cb);
  }

  unsubscribe(props?: Object, cb?: Callback | undefined) {
    this.write(
      Object.assign({ cmd: 'unsubscribe' }, props ?? {})! as Packet,
      cb
    );
  }

  unsuback(props?: Object, cb?: Callback | undefined) {
    this.write(Object.assign({ cmd: 'unsuback' }, props ?? {})! as Packet, cb);
  }

  pingreq(props?: Object, cb?: Callback | undefined) {
    this.write(Object.assign({ cmd: 'pingreq' }, props ?? {})! as Packet, cb);
  }

  pingresp(props?: Object, cb?: Callback | undefined) {
    this.write(Object.assign({ cmd: 'pingresp' }, props ?? {})! as Packet, cb);
  }

  disconnect(props?: Object, cb?: Callback | undefined) {
    this.write(
      Object.assign({ cmd: 'disconnect' }, props ?? {})! as Packet,
      cb
    );
  }
}

export class Server extends EventEmitter {
  protected server: net.Server;
  protected _opts: Object | undefined;

  constructor(opts?: Object) {
    super();
    this._opts = opts;
    this.server = net.createServer();
    this.server.on('connection', (socket: net.Socket) => {
      this.emit('connection', new Client(socket, this._opts));
    });
    this.server.on('error', this.emit.bind(this, 'error'));
    this.server.on('close', this.emit.bind(this, 'close'));
    this.server.on('listening', this.emit.bind(this, 'listening'));
  }

  listen(
    opts: { port: number; host: string; reuseAddress?: boolean },
    callback?: Callback
  ) {
    this.server.listen(opts, callback);
  }

  close(callback?: Callback) {
    this.server.close(callback);
  }
}

export default Server;

export { SimpleMQBroker } from './simple-mq';
