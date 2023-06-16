import * as React from 'react';

import { StyleSheet, View, Text } from 'react-native';
import { SimpleMQBroker } from 'react-native-mqtt-server';
import type { Buffer } from 'buffer';

export default function App() {
  const broker = React.useRef<SimpleMQBroker>(new SimpleMQBroker());

  React.useEffect(() => {
    broker.current.on('message', (topic: string, message: Buffer | string) => {
      console.log('message', topic, message);
    });
    broker.current.start();
  }, []);

  return (
    <View style={styles.container}>
      <Text>Run MQ broker on 1883</Text>
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
