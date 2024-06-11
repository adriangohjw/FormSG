/**
 * This file compiles to datadog-chunk.js which is then loaded in the <head> of the react app
 * This ensures that datadog is initialised before the react app
 */

import { datadogRum, RumInitConfiguration } from '@datadog/browser-rum'

// Discard benign RUM errors.
export const ddBeforeSend: RumInitConfiguration['beforeSend'] = (event) => {
  // TODO(#4279): Might want to remove this once we are fully React, since then we will not need to check auth state.
  // Discard unauth'd errors
  if (event.type === 'resource' && event.resource.status_code === 404) {
    return false
  }

  if (event.type !== 'error') return

  // Caused by @chakra-ui/react@latest-v1 -> @chakra-ui/modal@1.11.1 -> react-remove-scroll@2.4.1
  // Already fixed in @chakra-ui/react@latest, but we cannot upgrade until we upgrade to React 18.
  // See https://github.com/theKashey/react-remove-scroll/issues/8.
  // TODO(#4889): Remove this when we update to React 18.
  if (event.error.type === 'IgnoredEventCancel') {
    return false
  }

  // Discard benign ResizeObserver loop limit exceeded errors
  if (event.error.message.includes('ResizeObserver loop limit exceeded')) {
    return false
  }
}

// Init Datadog RUM
// Values for VITE_APP_DD_RUM_APP_ID, VITE_APP_DD_RUM_CLIENT_TOKEN, VITE_APP_DD_RUM_ENV, VITE_APP_VERSION, VITE_APP_DD_SAMPLE_RATE will be injected at build time
datadogRum.init({
  applicationId: '@VITE_APP_DD_RUM_APP_ID',
  clientToken: '@VITE_APP_DD_RUM_CLIENT_TOKEN',
  env: '@VITE_APP_DD_RUM_ENV',
  site: 'datadoghq.com',
  service: 'formsg-react',
  allowedTracingUrls: ['@VITE_APP_URL'],

  // Specify a version number to identify the deployed version of your application in Datadog
  version: '@VITE_APP_VERSION',
  // TODO/RUM: Update these RUM percentages as we increase the rollout percentage!
  sampleRate: Number('@VITE_APP_DD_SAMPLE_RATE') || 5,
  replaySampleRate: 100,
  trackInteractions: true,
  defaultPrivacyLevel: 'mask-user-input',
  beforeSend: ddBeforeSend,
})

datadogRum.startSessionReplayRecording()
