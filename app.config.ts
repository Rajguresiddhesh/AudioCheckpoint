import type { ConfigContext, ExpoConfig } from 'expo/config';

/**
 * Extends app.json with the Google Maps API key, read from the environment so it
 * is never committed. Set GOOGLE_MAPS_API_KEY (e.g. in a git-ignored `.env`)
 * before `expo prebuild` / `eas build`. Without it the app still builds and the
 * "Google map" view is hidden (react-native-maps crashes on Android if a Google
 * map is shown without a key).
 */
export default ({ config }: ConfigContext): ExpoConfig => {
  const googleMapsApiKey = process.env.GOOGLE_MAPS_API_KEY?.trim() || '';
  return {
    ...(config as ExpoConfig),
    plugins: [
      ...(config.plugins ?? []),
      ['react-native-maps', googleMapsApiKey ? { androidGoogleMapsApiKey: googleMapsApiKey } : {}],
    ],
    extra: {
      ...config.extra,
      googleMapsConfigured: googleMapsApiKey.length > 0,
    },
  };
};
