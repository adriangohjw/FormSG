import { Divider } from '@chakra-ui/react'

import { FormResponseMode, FormSettings } from '~shared/types/form'

import { FormSubmitterIdCollectionToggle } from './FormNricCollectionToggle'
import { FormSingleSubmissionToggle } from './FormSingleSubmissionToggle'
import { SingpassAuthOptionsRadio } from './SingpassAuthOptionsRadio'

export interface AuthSettingsSingpassSectionProps {
  settings: FormSettings
  isFormPublic: boolean
  containsMyInfoFields: boolean
}

export const AuthSettingsSingpassSection = ({
  settings,
  isFormPublic,
  containsMyInfoFields,
}: AuthSettingsSingpassSectionProps): JSX.Element => {
  return (
    <>
      <SingpassAuthOptionsRadio
        settings={settings}
        isDisabled={isFormPublic || containsMyInfoFields}
      />
      <>
        <Divider my="2.5rem" />
        <FormSubmitterIdCollectionToggle
          settings={settings}
          isDisabled={isFormPublic}
        />
      </>
      {settings.isSingleSubmission ||
      settings.responseMode === FormResponseMode.Encrypt ? (
        <>
          <Divider my="2.5rem" />
          <FormSingleSubmissionToggle
            settings={settings}
            isDisabled={isFormPublic}
          />
        </>
      ) : null}
    </>
  )
}
