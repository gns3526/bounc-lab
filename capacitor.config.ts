import type { CapacitorConfig } from '@capacitor/cli';

// Store registration has not happened yet. If the application ID changes,
// update this value and regenerate android/ before the first store upload.
const config: CapacitorConfig = {
  appId: 'com.jellysnow.penguinbounce',
  appName: '펭귄 바운스',
  webDir: 'dist',
  server: {
    androidScheme: 'https',
  },
  android: {
    allowMixedContent: false,
    backgroundColor: '#dff5ff',
  },
};

export default config;
