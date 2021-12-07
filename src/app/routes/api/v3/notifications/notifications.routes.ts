import { Router } from 'express'

import { handleTwilioSmsUpdates } from '../../../../modules/twilio/twilio.controller'

import { BouncesRouter } from './bounces'

export const NotificationsRouter = Router()

NotificationsRouter.use('/bounces', BouncesRouter)

/**
 * Receives and logs all SMS delivery status updates from Twilio webhook
 *
 * Path here is required to be synced with statusCallbackRoute under
 * sms.service#sendSms
 *
 * @route POST /api/v3/notifications/twilio
 *
 * @returns 200 when message succesfully received and logged
 * @returns 400 when request is not coming from Twilio or request body s invalid
 */
NotificationsRouter.post('/twilio', handleTwilioSmsUpdates)
