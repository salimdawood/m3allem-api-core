import { SNSClient, PublishCommand } from '@aws-sdk/client-sns';
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import { env } from '../../config/env.js';
import { AppError } from '../../utils/AppError.js';
import { logger } from '../../config/logger.js';

const sns=new SNSClient({region:env.S3_REGION});
const ses=new SESv2Client({region:env.S3_REGION});
export const liveOtpDelivery={
  async send(destination,code){
    try{
      if(destination.startsWith('+')) await sns.send(new PublishCommand({PhoneNumber:destination,Message:`Your M3allem verification code is ${code}. It expires in 5 minutes.`}));
      else {
        if(!env.OTP_EMAIL_FROM)throw new AppError('OTP_DELIVERY_UNAVAILABLE',503);
        await ses.send(new SendEmailCommand({FromEmailAddress:env.OTP_EMAIL_FROM,Destination:{ToAddresses:[destination]},Content:{Simple:{Subject:{Data:'M3allem verification code'},Body:{Text:{Data:`Your M3allem verification code is ${code}. It expires in 5 minutes.`}}}}}));
      }
    }catch(error){if(error instanceof AppError)throw error;throw new AppError('OTP_DELIVERY_UNAVAILABLE',503);}
  }
};

export const otpDelivery = env.DELIVERY_MODE === 'mock' ? {
  async send(destination) {
    logger.info({ deliveryMode: 'mock', channel: destination.startsWith('+') ? 'sms' : 'email' }, 'Mock OTP delivery accepted');
  }
} : liveOtpDelivery;
