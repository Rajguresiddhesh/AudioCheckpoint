// The background location task must be defined before anything else runs so
// Android can deliver fixes after restarting the JS runtime headlessly.
import { registerLocationTask } from './src/location/trackingService';

registerLocationTask();

// eslint-disable-next-line import/first
import 'expo-router/entry';
