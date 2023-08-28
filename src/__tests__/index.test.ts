import * as mqtt from 'mqtt';
import net, { AddressInfo } from 'net';
import { SimpleMQBroker } from '../index';

const getFreePort = () =>
  new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, () => {
      const { port } = server.address() as AddressInfo;
      server.close(() => resolve(port));
    });
  });

test('Work correctly', async () => {
  const port = await getFreePort();
  const broker = new SimpleMQBroker();
  broker.on('clientConnected', (clientId) => {
    expect(clientId).toMatchSnapshot('clientConnected');
  });
  broker.on('clientDisconnected', (clientId) => {
    expect(clientId).toMatchSnapshot('clientDisconnected');
    broker.stop();
  });
  broker.on('messageSend', (clientId, messageId) => {
    expect({ clientId, messageId }).toMatchSnapshot('messageSend');
  });
  broker.on('message', (topic, message) => {
    expect({ topic, message: String(message) }).toMatchSnapshot('server');
  });
  broker.start(port);
  await new Promise((resolve, reject) => {
    broker.on('error', reject);
    broker.on('listening', resolve);
  });
  const client = mqtt.connect(`mqtt://0.0.0.0:${port}`, {
    clientId: 'test',
    clean: true,
  });
  await new Promise((resolve, reject) => {
    client.on('error', reject);
    client.on('connect', resolve);
  });
  {
    let count = 0;
    client.on('message', (topic, message) => {
      expect({ topic, message: String(message) }).toMatchSnapshot('client');
      if (++count === 3) {
        client.end();
      }
    });
  }
  client.subscribe('test', { qos: 1 });
  client.subscribe('test/path', { qos: 2 });
  client.subscribe('test/1/+');
  client.subscribe('test/2/#');
  client.publish('test', 'test');
  client.publish('test/path', 'test/path');
  client.publish(
    'test/1/should/not/be/received',
    'test/1/should/not/be/received'
  );
  client.publish('test/2/should/be/received', 'test/2/should/be/received');
  await new Promise((resolve, reject) => {
    broker.on('error', reject);
    broker.on('close', resolve);
  });
});
