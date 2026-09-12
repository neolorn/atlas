import { type ApplicationConfig, mergeApplicationConfig } from '@angular/core';

import { appConfig } from './app.config';
import { serverRendering } from './app.routes.server';
import { provideSsrProbe } from './ssr-probe';

const serverOnlyConfig: ApplicationConfig = {
  providers: [serverRendering, provideSsrProbe()],
};

export const serverConfig = mergeApplicationConfig(appConfig, serverOnlyConfig);
