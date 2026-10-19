import { healthService } from './health.service.js';
export const healthController={live:()=>healthService.live(),ready:()=>healthService.ready(),apiHealth:()=>healthService.apiHealth(),appConfig:()=>healthService.appConfig()};
