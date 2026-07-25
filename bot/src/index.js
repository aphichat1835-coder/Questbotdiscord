import {
  fatalBootstrapShutdown,
  installBootstrapProcessHandlers,
} from './bootstrap.js';
import { INCIDENT } from './incident-catalog.js';

const removeBootstrapHandlers = installBootstrapProcessHandlers();

try {
  const { createApp } = await import('./app.js');
  const app = createApp();
  app.installProcessHandlers();
  removeBootstrapHandlers();
  await app.start();
} catch (error) {
  removeBootstrapHandlers();
  await fatalBootstrapShutdown({
    code: INCIDENT.CLIENT_STARTUP_FAILED,
    error,
    context: { stage: 'module-import', component: 'application' },
  });
}
