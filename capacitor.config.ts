import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'finance.doo.garmindishlogger',
  appName: 'Dish Logger',
  webDir: 'public',
  plugins: {
    CapacitorHttp: {
      enabled: true,
    },
  },
  android: {
    allowMixedContent: true,
    backgroundColor: '#0b0f17',
  },
};

export default config;
