import * as React from 'react';

import { StyleSheet, View, Text, Pressable } from 'react-native';
import { SimpleMQBroker } from 'react-native-mqtt-server';
import type { Buffer } from 'buffer';

export default function App() {
  const broker = React.useRef<SimpleMQBroker>(new SimpleMQBroker());
  const [error, setError] = React.useState<Error | undefined>(undefined);
  const [started, setStarted] = React.useState(false);

  React.useEffect(() => {
    broker.current.on('error', (err: Error) => {
      setError(err);
      console.error(err);
    });
    broker.current.on('close', () => {
      setStarted(false);
    });
    broker.current.on('listening', () => {
      setStarted(true);
    });
    broker.current.on('message', (topic: string, message: Buffer | string) => {
      console.log('message', topic, message);
    });
    broker.current.start();

    return () => broker.current.stop();
  }, []);

  const stop = React.useCallback(() => {
    broker.current.stop();
  }, []);

  const start = React.useCallback(() => {
    broker.current.start();
  }, []);

  return (
    <View style={styles.container}>
      {started && <Text>Run MQ broker on port 1883</Text>}
      {error && <Text>{error.message}</Text>}
      {started && <Pressable onPress={stop} style={styles.box}>
        <Text>Stop</Text>
      </Pressable>}
      {!started && <Pressable onPress={start} style={styles.box}>
        <Text>Start</Text>
      </Pressable>}
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
    marginVertical: 20,
    padding: 20,
  },
});
