import * as React from 'react';

import { StyleSheet, View, Text } from 'react-native';
import { Server, Client } from 'react-native-mqtt-server';

export default function App() {
  const server = React.useRef<Server>(new Server({ protocolVersion: 4 }));

  React.useEffect(() => {
    server.current.on('connect', (client: Client) => {
      client.on('connect', (packet) => {
        console.log('connect', packet);
        client.connack({ returnCode: 0 });
      });
      client.on('publish', (packet) => {
        console.log('publish', packet);
        client.puback({ messageId: packet.messageId });
      });
    });
    server.current.listen(1883);
  }, []);

  return (
    <View style={styles.container}>
      <Text>Result: {result}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  box: {
    width: 60,
    height: 60,
    marginVertical: 20,
  },
});
