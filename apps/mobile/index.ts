// The polyfill must run before anything imports @asms/shared (newIdempotencyKey needs
// crypto.randomUUID, which Hermes does not guarantee). Slice-15 §2.4.
import './src/platform/crypto-polyfill';
import 'expo-router/entry';
