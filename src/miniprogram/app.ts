import { config } from './config';

App({ onLaunch() {
  if (config.cloudEnvId && wx.cloud) wx.cloud.init({ env: config.cloudEnvId, traceUser: false });
} });
