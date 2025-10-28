import * as React from 'react';

import { StyleSheet, View, Text, Pressable } from 'react-native';
import { SimpleMQBroker } from 'react-native-mqtt-server';
import type { Buffer } from 'buffer';

export default function App() {
  const broker = React.useRef<SimpleMQBroker>(new SimpleMQBroker());
  const [error, setError] = React.useState<Error | undefined>(undefined);
  const [started, setStarted] = React.useState(false);

  React.useEffect(() => {
    const currBroker = broker.current;

    currBroker.on('error', (err: Error) => {
      setError(err);
      console.error(err);
    });
    currBroker.on('close', () => {
      setStarted(false);
    });
    currBroker.on('listening', () => {
      setStarted(true);
    });
    currBroker.on('message', (topic: string, message: Buffer | string) => {
      console.log('message', topic, message);
    });
    currBroker.start();

    return () => {
      currBroker.stop();
    };
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
      {started && (
        <Pressable onPress={stop} style={styles.box}>
          <Text>Stop</Text>
        </Pressable>
      )}
      {!started && (
        <Pressable onPress={start} style={styles.box}>
          <Text>Start</Text>
        </Pressable>
      )}
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
