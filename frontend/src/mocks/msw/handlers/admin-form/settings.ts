import { pick } from 'lodash'
import { rest } from 'msw'

import {
  EMAIL_FORM_SETTINGS_FIELDS,
  STORAGE_FORM_SETTINGS_FIELDS,
} from '~shared/constants/form'
import { FormId, FormResponseMode, FormSettings } from '~shared/types/form/form'

import { createMockForm } from './form'

export const getAdminFormSettings = ({
  delay = 0,
  overrides,
  mode = FormResponseMode.Email,
}: {
  delay?: number | 'infinite'
  overrides?: Partial<FormSettings>
  mode?: FormResponseMode
} = {}) => {
  return rest.get<FormSettings>(
    '/api/v3/admin/forms/:formId/settings',
    (req, res, ctx) => {
      return res(
        ctx.delay(delay),
        ctx.status(200),
        ctx.json(
          pick(
            createMockForm({
              _id: req.params.formId as FormId,
              responseMode: mode,
              ...overrides,
            }).form,
            mode === FormResponseMode.Email
              ? EMAIL_FORM_SETTINGS_FIELDS
              : STORAGE_FORM_SETTINGS_FIELDS,
          ),
        ),
      )
    },
  )
}

export const patchAdminFormSettings = ({
  delay = 0,
  overrides,
  mode = FormResponseMode.Email,
}: {
  delay?: number | 'infinite'
  overrides?: Partial<FormSettings>
  mode?: FormResponseMode
} = {}) => {
  return rest.patch<Partial<FormSettings>>(
    '/api/v3/admin/forms/:formId/settings',
    (req, res, ctx) => {
      return res(
        ctx.delay(delay),
        ctx.status(200),
        ctx.json(
          pick(
            createMockForm({
              _id: req.params.formId as FormId,
              responseMode: mode,
              ...overrides,
              ...req.body,
            }).form,
            mode === FormResponseMode.Email
              ? EMAIL_FORM_SETTINGS_FIELDS
              : STORAGE_FORM_SETTINGS_FIELDS,
          ),
        ),
      )
    },
  )
}

export const putFormWhitelistSettingSimulateCsvStringValidationError = (
  formId: string,
) => {
  return rest.put<Partial<FormSettings>>(
    `/api/v3/admin/forms/${formId}/settings/whitelist`,
    (req, res, ctx) => {
      return res(
        ctx.status(422),
        ctx.json({
          message: 'Storybook whitelist update mock validation error',
        }),
      )
    },
  )
}
