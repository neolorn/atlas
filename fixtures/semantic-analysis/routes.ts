import type { Routes } from '@angular/router';

import { ProbeComponent } from './probe.component';

export const routes = [
  {
    path: '',
    component: ProbeComponent,
  },
  {
    path: 'about',
    loadComponent: () =>
      import('./about.component').then((module) => module.AboutComponent),
  },
] satisfies Routes;
