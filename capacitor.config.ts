import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'finance.doo.dishlogger',
  appName: 'Dish Logger',
  webDir: 'public',
  plugins: {
    CapacitorHttp: {
      enabled: false,
    },
  },
  android: {
    allowMixedContent: true,
    backgroundColor: '#0b0f17',
  },
};

export default config;
