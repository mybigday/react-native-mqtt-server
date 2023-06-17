# react-native-mqtt-server

MQTT server on React Native

## Installation

```sh
npm install react-native-mqtt-server
```

## Usage

```js
import { Server, SimpleMQBroker } from 'react-native-mqtt-server';

// Use simple broker
const broker = new SimpleMQBroker();
broker.start();
broker.on('connect', id => console.log('Client connected', id));
broker.on('message', (topic, payload) => console.log('Message received', topic, payload));

// Use as MQTT server directly
const server = new Server();
server.on('connection', client => {
  client.on('data', packet => {
    console.log('Packet received', packet);
  });
});
server.listen(1883);
```

## Contributing

See the [contributing guide](CONTRIBUTING.md) to learn how to contribute to the repository and the development workflow.

## License

MIT

---

Made with [create-react-native-library](https://github.com/callstack/react-native-builder-bob)

---

<p align="center">
  <a href="https://bricks.tools">
    <img width="90px" src="https://avatars.githubusercontent.com/u/17320237?s=200&v=4">
  </a>
  <p align="center">
    Built and maintained by <a href="https://bricks.tools">BRICKS</a>.
  </p>
</p>

