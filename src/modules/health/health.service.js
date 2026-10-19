import { env } from '../../config/env.js';
import { healthRepository } from './health.repository.js';
let draining=false;
export const healthService={
 markDraining:()=>{draining=true;},
 live:()=>({success:true,status:'live',timestamp:new Date().toISOString()}),
 async ready(){if(draining)return{statusCode:503,data:{success:false,status:'unavailable'}};try{await healthRepository.checkDatabase();return{success:true,status:'ready',timestamp:new Date().toISOString()};}catch{return{statusCode:503,data:{success:false,status:'unavailable'}};}},
 apiHealth:()=>({status:'ok',env:env.APP_ENV,version:'1.0.0'}),
 appConfig:()=>({minSupportedVersion:'1.0.0',legalUrl:'https://samdroid.mobi/privacy-policy-m3allem'})
};
