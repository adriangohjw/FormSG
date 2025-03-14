import { AWSError, SecretsManager } from 'aws-sdk'
import { PresignedPost } from 'aws-sdk/clients/s3'
import {
  CreateSecretRequest,
  DeleteSecretRequest,
  PutSecretValueRequest,
} from 'aws-sdk/clients/secretsmanager'
import { assignIn, last, omit, pick } from 'lodash'
import mongoose, { ClientSession } from 'mongoose'
import { err, errAsync, ok, okAsync, Result, ResultAsync } from 'neverthrow'
import {
  EncryptedStringsMessageContent,
  EncryptedStringsMessageContentWithMyPrivateKey,
} from 'shared/utils/crypto'
import type { Except, Merge } from 'type-fest'

import {
  FORM_WHITELIST_CONTAINS_EMPTY_ROWS_ERROR_MESSAGE,
  FORM_WHITELIST_SETTING_CONTAINS_DUPLICATES_ERROR_MESSAGE,
  FORM_WHITELIST_SETTING_CONTAINS_INVALID_FORMAT_SUBMITTERID_ERROR_MESSAGE,
  MAX_UPLOAD_FILE_SIZE,
  VALID_UPLOAD_FILE_TYPES,
  WHITELISTED_SUBMITTER_ID_DECRYPTION_FIELDS,
} from '../../../../../shared/constants'
import { MYINFO_ATTRIBUTE_MAP } from '../../../../../shared/constants/field/myinfo'
import {
  AdminDashboardFormMetaDto,
  DuplicateFormOverwriteDto,
  EndPageUpdateDto,
  FieldCreateDto,
  FieldUpdateDto,
  FormAuthType,
  FormLogoState,
  FormPermission,
  FormResponseMode,
  FormSettings,
  LogicDto,
  PaymentChannel,
  SettingsUpdateDto,
  StartPageUpdateDto,
  StorageFormSettings,
} from '../../../../../shared/types'
import {
  isMFinSeriesValid,
  isNricValid,
} from '../../../../../shared/utils/nric-validation'
import { isUenValid } from '../../../../../shared/utils/uen-validation'
import { EditFieldActions } from '../../../../shared/constants'
import {
  FormFieldSchema,
  FormLogicSchema,
  IForm,
  IFormDocument,
  IFormSchema,
  IPopulatedForm,
  IPopulatedUser,
} from '../../../../types'
import { EditFormFieldParams, FormUpdateParams } from '../../../../types/api'
import config, { aws as AwsConfig } from '../../../config/config'
import { createLoggerWithLabel } from '../../../config/logger'
import getAgencyModel from '../../../models/agency.server.model'
import getFormModel from '../../../models/form.server.model'
import getFormWhitelistSubmitterIdsModel from '../../../models/form_whitelist.server.model'
import { getWorkspaceModel } from '../../../models/workspace.server.model'
import { twilioClientCache } from '../../../services/sms/sms.service'
import {
  createPresignedPostDataPromise,
  CreatePresignedPostError,
} from '../../../utils/aws-s3'
import { dotifyObject } from '../../../utils/dotify-object'
import {
  getMongoErrorMessage,
  transformMongoError,
} from '../../../utils/handle-mongo-error'
import {
  DatabaseConflictError,
  DatabaseError,
  DatabasePayloadSizeError,
  DatabaseValidationError,
  MalformedParametersError,
  PossibleDatabaseError,
  SecretsManagerError,
  SecretsManagerNotFoundError,
  TwilioCacheError,
} from '../../core/core.errors'
import { MissingUserError } from '../../user/user.errors'
import * as UserService from '../../user/user.service'
import { removeFormsFromAllWorkspaces } from '../../workspace/workspace.service'
import {
  FormNotFoundError,
  FormWhitelistSettingNotFoundError,
  LogicNotFoundError,
  TransferOwnershipError,
} from '../form.errors'
import { getFormModelByResponseMode } from '../form.service'
import {
  getFormFieldById,
  getFormFieldIndexById,
  getLogicById,
  isFormEncryptMode,
} from '../form.utils'

import {
  TwilioCredentials,
  TwilioCredentialsData,
} from './../../../services/sms/sms.types'
import { PRESIGNED_POST_EXPIRY_SECS } from './admin-form.constants'
import {
  EditFieldError,
  FieldNotFoundError,
  InvalidCollaboratorError,
  InvalidFileTypeError,
} from './admin-form.errors'
import {
  checkIsApiSecretKeyName,
  generateTwilioCredSecretKeyName,
  getUpdatedFormFields,
  insertTableShortTextColumnDefaultValidationOptions,
  processDuplicateOverrideProps,
} from './admin-form.utils'

const logger = createLoggerWithLabel(module)
const FormModel = getFormModel(mongoose)
const AgencyModel = getAgencyModel(mongoose)
const WorkspaceModel = getWorkspaceModel(mongoose)
const FormWhitelistedSubmitterIdsModel =
  getFormWhitelistSubmitterIdsModel(mongoose)

export const secretsManager = new SecretsManager({
  region: config.aws.region,
  endpoint: process.env.AWS_ENDPOINT,
})

type PresignedPostUrlParams = {
  fileId: string
  fileMd5Hash: string
  fileType: string
}

/**
 * Retrieves a list of forms that the user of the given userId can access in
 * their dashboard.
 * @param userId the id of the user to retrieve accessible forms for.
 * @returns ok(DashboardFormViewList)
 * @returns err(MissingUserError) if user with userId does not exist in the database
 * @returns err(DatabaseError) if error occurs whilst querying the database
 */
export const getDashboardForms = (
  userId: string,
): ResultAsync<
  AdminDashboardFormMetaDto[],
  MissingUserError | DatabaseError
> => {
  // Step 1: Verify user exists.
  return (
    UserService.findUserById(userId)
      // Step 2: Retrieve lists users are authorized to see.
      .andThen((admin) => {
        return ResultAsync.fromPromise(
          FormModel.getMetaByUserIdOrEmail(userId, admin.email),
          (error) => {
            logger.error({
              message: 'Database error when retrieving admin dashboard forms',
              meta: {
                action: 'getDashboardForms',
                userId,
              },
              error,
            })

            return new DatabaseError()
          },
        )
      })
  )
}

/**
 * Private function to generate a presigned POST URL to upload into the given
 * bucket.
 *
 * @param bucketName the name of the bucket to upload into
 * @param param.fileId key of the file
 * @param param.fileMd5Hash the MD5 hash of the file
 * @param param.fileType the file type of the file
 */
const createPresignedPostUrl = (
  bucketName: string,
  { fileId, fileMd5Hash, fileType }: PresignedPostUrlParams,
): ResultAsync<
  PresignedPost,
  InvalidFileTypeError | CreatePresignedPostError
> => {
  if (!VALID_UPLOAD_FILE_TYPES.includes(fileType)) {
    return errAsync(
      new InvalidFileTypeError(`"${fileType}" is not a supported file type`),
    )
  }

  const presignedPostUrlPromise = createPresignedPostDataPromise({
    bucketName,
    expiresSeconds: PRESIGNED_POST_EXPIRY_SECS,
    size: MAX_UPLOAD_FILE_SIZE,
    key: fileId,
    acl: 'public-read',
    fileMd5Hash,
    fileType,
  })

  return presignedPostUrlPromise.mapErr((error) => {
    logger.error({
      message: 'Error encountered when creating presigned POST URL',
      meta: {
        action: 'createPresignedPostUrl',
        fileId,
        fileMd5Hash,
        fileType,
      },
      error,
    })

    return new CreatePresignedPostError('Error occurred whilst uploading file')
  })
}

/**
 * Creates a S3 presigned POST URL for the client to upload images directly to.
 *
 * @param param.fileId key of the file
 * @param param.fileMd5Hash the MD5 hash of the file
 * @param param.fileType the file type of the file
 *
 * @returns ok(presigned post url) when creation is successful
 * @returns err(InvalidFileTypeError) when given file type is not supported
 * @returns err(CreatePresignedPostError) when errors occurs on S3 side whilst creating presigned post url.
 */
export const createPresignedPostUrlForImages = (
  uploadParams: PresignedPostUrlParams,
): ResultAsync<
  PresignedPost,
  InvalidFileTypeError | CreatePresignedPostError
> => {
  return createPresignedPostUrl(AwsConfig.imageS3Bucket, uploadParams)
}

/**
 * Creates a S3 presigned POST URL for the client to upload logos directly to.
 *
 * @param param.fileId key of the file
 * @param param.fileMd5Hash the MD5 hash of the file
 * @param param.fileType the file type of the file
 *
 * @returns ok(presigned post url) when creation is successful
 * @returns err(InvalidFileTypeError) when given file type is not supported
 * @returns err(CreatePresignedPostError) when errors occurs on S3 side whilst creating presigned post url.
 */
export const createPresignedPostUrlForLogos = (
  uploadParams: PresignedPostUrlParams,
): ResultAsync<
  PresignedPost,
  InvalidFileTypeError | CreatePresignedPostError
> => {
  return createPresignedPostUrl(AwsConfig.logoS3Bucket, uploadParams)
}

/**
 * Extracts IDs of MyInfo fields
 * @param formFields
 * @returns List of IDs of MyInfo fields
 */
export const extractMyInfoFieldIds = (
  formFields: FormFieldSchema[] | undefined,
): string[] => {
  return formFields
    ? formFields
        .filter((field) => field.myInfo?.attr)
        .map((field) => field._id.toString())
    : []
}

/**
 * Archives given form.
 * @param form the form to archive
 * @returns ok(IFormSchema) if successful
 * @returns err(DatabaseError) if any database errors occur
 */
export const archiveForm = (
  form: IPopulatedForm,
): ResultAsync<
  IFormSchema,
  | DatabaseError
  | DatabaseValidationError
  | DatabaseConflictError
  | DatabasePayloadSizeError
> => {
  return ResultAsync.fromPromise(form.archive(), (error) => {
    logger.error({
      message: 'Database error encountered when archiving form',
      meta: {
        action: 'archiveForm',
        form,
      },
      error,
    })

    return transformMongoError(error)
    // On success, return form
  }).map((form) => form)
}

/**
 * Transfer form ownership from current owner to the new email.
 * @param currentForm the form to transfer ownership for
 * @param newOwnerEmail the email of the new owner to transfer to
 *
 * @return ok(updated form) if transfer is successful
 * @return err(MissingUserError) if the current form admin cannot be found
 * @return err(TransferOwnershipError) if new owner cannot be found in the database or new owner email is same as current owner
 * @return err(DatabaseError) if any database errors like missing admin of current owner occurs
 */
export const transferFormOwnership = (
  currentForm: IPopulatedForm,
  newOwnerEmail: string,
): ResultAsync<IPopulatedForm, TransferOwnershipError | DatabaseError> => {
  const logMeta = {
    action: 'transferFormOwnership',
    newOwnerEmail,
  }

  return (
    // Step 1: Retrieve current owner of form to transfer.
    UserService.findUserById(String(currentForm.admin._id))
      .andThen((currentOwner) => {
        // No need to transfer form ownership if new and current owners are
        // the same.
        if (
          newOwnerEmail.trim().toLowerCase() ===
          currentOwner.email.trim().toLowerCase()
        ) {
          return errAsync(
            new TransferOwnershipError(
              'You are already the owner of this form',
            ),
          )
        }
        return okAsync(currentOwner)
      })
      .andThen((currentOwner) =>
        // Step 2: Retrieve user document for new owner.
        UserService.findUserByEmail(newOwnerEmail)
          .mapErr((error) => {
            logger.error({
              message:
                'Error occurred whilst finding new owner email to transfer ownership to',
              meta: logMeta,
              error,
            })

            // Override MissingUserError with more specific message if new owner
            // cannot be found.
            if (error instanceof MissingUserError) {
              return new TransferOwnershipError(
                `${newOwnerEmail} must have logged in once before being added as Owner`,
              )
            }
            return error
          })
          // Step 3: Perform form ownership transfer.
          .andThen((newOwner) =>
            ResultAsync.fromPromise(
              currentForm.transferOwner<IPopulatedForm>(currentOwner, newOwner),
              (error) => {
                logger.error({
                  message: 'Error occurred whilst transferring form ownership',
                  meta: logMeta,
                  error,
                })

                return new DatabaseError(getMongoErrorMessage(error))
              },
            ),
          ),
      )
      // Step 4: Populate updated form.
      .andThen((updatedForm) =>
        ResultAsync.fromPromise(
          updatedForm.populate({ path: 'admin', populate: { path: 'agency' } }),
          (error) => {
            logger.error({
              message: 'Error occurred whilst populating form with admin',
              meta: logMeta,
              error,
            })

            return new DatabaseError(getMongoErrorMessage(error))
          },
        ),
      )
  )
}

/**
 * Transfer all forms belonging to the current owner to a new email.
 * @param currentOwnerEmail the email of the current owner
 * @param newOwnerEmail the email of the new owner to transfer to
 *
 * @return ok(true) if transfer is successful
 * @return err(MissingUserError) if the current form admin cannot be found
 * @return err(TransferOwnershipError) if new owner cannot be found in the database or new owner email is same as current owner
 * @return err(DatabaseError) if any database errors like missing admin of current owner occurs
 */
export const transferAllFormsOwnership = (
  currentOwner: IPopulatedUser,
  newOwnerEmail: string,
): ResultAsync<boolean, TransferOwnershipError | DatabaseError> => {
  const logMeta = {
    action: 'transferAllFormsOwnership',
    currentOwner,
    newOwnerEmail,
  }

  if (newOwnerEmail.toLowerCase() === currentOwner.email.toLowerCase()) {
    return errAsync(
      new TransferOwnershipError('You are already the owner of this form'),
    )
  }

  return (
    // Step 1: Retrieve user document for new owner.
    UserService.findUserByEmail(newOwnerEmail)
      .mapErr((error) => {
        logger.error({
          message:
            'Error occurred whilst finding new owner email to transfer ownership to',
          meta: logMeta,
          error,
        })
        // Override MissingUserError with more specific message if new owner
        // cannot be found.
        if (error instanceof MissingUserError) {
          return new TransferOwnershipError(
            `${newOwnerEmail} must have logged in once before being added as Owner`,
          )
        }
        return error
      })
      // Step 2: Perform form ownership transfer.
      .andThen((newOwner) =>
        ResultAsync.fromPromise(
          FormModel.removeNewOwnerFromPermissionListForAllCurrentOwnerForms(
            currentOwner,
            newOwner,
          ).then(() => newOwner),
          (error) => {
            logger.error({
              message:
                'Error occurred whilst removing new owner from permission list for current owner forms',
              meta: logMeta,
              error,
            })

            return new DatabaseError(getMongoErrorMessage(error))
          },
        ),
      )
      .andThen((newOwner) =>
        ResultAsync.fromPromise(
          FormModel.transferAllFormsToNewOwner(currentOwner, newOwner).then(
            () => newOwner,
          ),
          (error) => {
            logger.error({
              message: 'Error occurred whilst transferring form ownership',
              meta: logMeta,
              error,
            })

            return new DatabaseError(getMongoErrorMessage(error))
          },
        ),
      )
      // Step 3: On success, return true
      .map(() => true)
  )
}

/**
 * Creates a form with the given form params
 * @param formParams parameters for the form to be created.
 *
 * @returns ok(created form) on success
 * @returns err(Database*Error) on database errors
 */
export const createForm = (
  formParams: Merge<IForm, { admin: string }>,
  workspaceId?: string,
): ResultAsync<
  IFormDocument,
  | DatabaseError
  | DatabaseValidationError
  | DatabaseConflictError
  | DatabasePayloadSizeError
> => {
  const logMeta = {
    action: 'createForm',
    formParams,
  }

  if (workspaceId)
    return ResultAsync.fromPromise(
      createFormInWorkspaceTransaction(formParams, workspaceId),
      (error) => {
        logger.error({
          message:
            'Database error encountered when creating form and moving it to workspace',
          meta: {
            ...logMeta,
            workspaceId,
          },
          error,
        })

        return transformMongoError(error)
      },
    )
  return ResultAsync.fromPromise(
    FormModel.create(formParams) as Promise<IFormDocument>,
    (error) => {
      logger.error({
        message: 'Database error encountered when creating form',
        meta: {
          ...logMeta,
        },
        error,
      })

      return transformMongoError(error)
    },
  )
}

// Helper method to create form and move it into a specified workspace,
// error handling will be done in parent createForm method.
// Exported for testing
export const createFormInWorkspaceTransaction = async (
  formParams: Merge<IForm, { admin: string }>,
  workspaceId: string,
): Promise<IFormDocument> => {
  let form: IFormDocument
  const session = await mongoose.startSession()
  return session
    .withTransaction(async () => {
      form = await processCreateFormInWorkspace(
        formParams,
        workspaceId,
        session,
      )
    })
    .then(() => form)
    .finally(() => session.endSession)
}

export const processCreateFormInWorkspace = async (
  formParams: Merge<IForm, { admin: string }>,
  workspaceId: string,
  session?: ClientSession,
): Promise<IFormDocument> => {
  // in order to take Mongoose.SaveOptions as a parameter with session
  // we have to use the create type with array docs input
  // https://mongoosejs.com/docs/5.x/docs/transactions.html
  // hence we have to hard access the first element of the array
  const form = (
    await FormModel.create([formParams], {
      session,
    })
  )[0] as IFormDocument
  await WorkspaceModel.addFormIdsToWorkspace({
    workspaceId,
    formIds: [form._id],
    session,
  })
  return form
}

/**
 * Duplicates given formId and replace owner with newAdminId.
 * @param originalForm the form to be duplicated
 * @param newAdminId the id of the admin of the duplicated form
 * @param overrideParams params to override in the duplicated form; e.g. the new emails or public key of the form.
 * @param workspaceId the id of the workspace to duplicate the form into
 * @returns the newly created duplicated form
 */
export const duplicateForm = (
  originalForm: IFormDocument,
  newAdminId: string,
  overrideParams: DuplicateFormOverwriteDto,
  workspaceId?: string,
): ResultAsync<IFormDocument, FormNotFoundError | DatabaseError> => {
  const overrideProps = processDuplicateOverrideProps(
    overrideParams,
    newAdminId,
  )

  // Set startPage.logo to default irregardless.
  overrideProps.startPage = {
    ...originalForm.startPage,
    logo: { state: FormLogoState.Default },
  }
  // Prevent buttonLink from being copied over if buttonLink is the default
  // form hash.
  if (originalForm.endPage?.buttonLink === `#!/${originalForm._id}`) {
    overrideProps.endPage = omit(originalForm.endPage, 'buttonLink')
  }

  const duplicateParams = originalForm.getDuplicateParams(overrideProps)

  if (workspaceId)
    return ResultAsync.fromPromise(
      createFormInWorkspaceTransaction(duplicateParams, workspaceId),
      (error) => {
        logger.error({
          message: 'Error encountered while duplicating form into a workspace',
          meta: {
            action: 'duplicateForm',
            duplicateParams,
            newAdminId,
            workspaceId,
          },
          error,
        })

        return new DatabaseError(getMongoErrorMessage(error))
      },
    )

  return ResultAsync.fromPromise(
    FormModel.create(duplicateParams) as Promise<IFormDocument>,
    (error) => {
      logger.error({
        message: 'Error encountered while duplicating form',
        meta: {
          action: 'duplicateForm',
          duplicateParams,
          newAdminId,
        },
        error,
      })

      return new DatabaseError(getMongoErrorMessage(error))
    },
  )
}

/**
 * Updates the targeted form field with the new field provided
 * @param form the form the field to update belongs to
 * @param fieldId the id of the field to update
 * @param newField the new field to replace with
 * @returns ok(updatedField)
 * @returns err(FieldNotFoundError) if fieldId does not correspond to any field in the form
 * @returns err(PossibleDatabaseError) when database errors arise
 */
export const updateFormField = (
  form: IPopulatedForm,
  fieldId: string,
  newField: FieldUpdateDto,
): ResultAsync<FormFieldSchema, PossibleDatabaseError | FieldNotFoundError> => {
  const _newField = insertTableShortTextColumnDefaultValidationOptions(newField)

  return ResultAsync.fromPromise(
    form.updateFormFieldById(fieldId, _newField),
    (error) => {
      logger.error({
        message: 'Error encountered while updating form field',
        meta: {
          action: 'updateFormField',
          formId: form._id,
          fieldId,
          newField,
        },
        error,
      })

      return transformMongoError(error)
    },
  ).andThen((updatedForm) => {
    if (!updatedForm) {
      return errAsync(new FieldNotFoundError())
    }
    const updatedFormField = getFormFieldById(updatedForm.form_fields, fieldId)
    return updatedFormField
      ? okAsync(updatedFormField)
      : errAsync(new FieldNotFoundError())
  })
}

/**
 * Duplicates the form field of the corresponding fieldId
 * @param form the original form to duplicate form field for
 * @param fieldId fieldId of the the form field to duplicate
 *
 * @returns ok(duplicated field)
 * @returns err(PossibleDatabaseError) when database errors arise
 */
export const duplicateFormField = (
  form: IPopulatedForm,
  fieldId: string,
): ResultAsync<
  FormFieldSchema,
  PossibleDatabaseError | FormNotFoundError | FieldNotFoundError
> => {
  const fieldIndex = getFormFieldIndexById(form.form_fields, fieldId)
  // if fieldIndex does not exist, append to end of form fields
  const insertionIndex =
    fieldIndex === null ? form.form_fields.length : fieldIndex + 1
  return ResultAsync.fromPromise(
    form.duplicateFormFieldByIdAndIndex(fieldId, insertionIndex),
    (error) => {
      logger.error({
        message: 'Error encountered while duplicating form field',
        meta: {
          action: 'duplicateFormField',
          formId: form._id,
          fieldId,
          fieldIndex,
          insertionIndex,
        },
        error,
      })

      return transformMongoError(error)
    },
  ).andThen((updatedForm) => {
    if (!updatedForm) {
      // Success means field is in initial form object but query still returned null.
      // Return best guess error that form is now not found in the DB.
      // Otherwise, err(FieldNotFoundError) will be returned by the function.
      return getFormField(form, fieldId).asyncAndThen(() =>
        errAsync(new FormNotFoundError()),
      )
    }
    const updatedField = updatedForm.form_fields[insertionIndex]
    return updatedField
      ? okAsync(updatedField)
      : errAsync(new FieldNotFoundError())
  })
}

/**
 * Inserts a new form field into given form's fields with the field provided
 * @param form the form to insert the new field into
 * @param newField the new field to insert
 * @param to optional index to insert the new field at
 * @returns ok(created form field)
 * @returns err(PossibleDatabaseError) when database errors arise
 */
export const createFormField = (
  form: IPopulatedForm,
  newField: FieldCreateDto,
  to?: number,
): ResultAsync<
  FormFieldSchema,
  PossibleDatabaseError | FormNotFoundError | FieldNotFoundError
> => {
  // If MyInfo field, override field title to stored name.
  if (newField.myInfo?.attr) {
    newField.title =
      MYINFO_ATTRIBUTE_MAP[newField.myInfo.attr]?.value ?? newField.title
  }

  return ResultAsync.fromPromise(
    form.insertFormField(newField, to),
    (error) => {
      logger.error({
        message: 'Error encountered while inserting new form field',
        meta: {
          action: 'createFormField',
          formId: form._id,
          newField,
        },
        error,
      })

      return transformMongoError(error)
    },
  ).andThen((updatedForm) => {
    if (!updatedForm) {
      return errAsync(new FormNotFoundError())
    }
    let indexToRetrieve = updatedForm.form_fields.length - 1
    // Must use undefined check since number can be 0; i.e. falsey.
    if (to !== undefined) {
      // Bound indexToRetrieve to 0 and length - 1.
      indexToRetrieve = Math.min(Math.max(to, 0), indexToRetrieve)
    }
    const updatedField = updatedForm.form_fields[indexToRetrieve]
    return updatedField
      ? okAsync(updatedField)
      : errAsync(new FieldNotFoundError())
  })
}

/**
 * Reorders field with given fieldId to the given newPosition
 * @param form the form to reorder the field from
 * @param fieldId the id of the field to reorder
 * @param newPosition the new position of the field
 * @returns ok(reordered field)
 * @returns err(FieldNotFoundError) if field id is invalid
 * @returns err(PossibleDatabaseError) if any database errors occur
 */
export const reorderFormField = (
  form: IPopulatedForm,
  fieldId: string,
  newPosition: number,
): ResultAsync<
  FormFieldSchema[],
  PossibleDatabaseError | FieldNotFoundError
> => {
  return ResultAsync.fromPromise(
    form.reorderFormFieldById(fieldId, newPosition),
    (error) => {
      logger.error({
        message: 'Error encountered while reordering form field',
        meta: {
          action: 'reorderFormField',
          formId: form._id,
          fieldId,
          newPosition,
        },
        error,
      })

      return transformMongoError(error)
    },
  ).andThen((updatedForm) => {
    if (!updatedForm) {
      return errAsync(new FieldNotFoundError())
    }

    return okAsync(updatedForm.form_fields)
  })
}

/**
 * Updates form fields of given form depending on the given editFormFieldParams
 * @param originalForm the original form to update form fields for
 * @param editFormFieldParams the parameters stating the type of updates and the position metadata if update type is edit
 *
 * @returns ok(updated form) if form fields update successfully
 * @returns err(EditFieldError) if invalid updates are being performed to form fields
 * @returns err(set of DatabaseError) if any database errors occurs
 */
export const editFormFields = (
  originalForm: IPopulatedForm,
  editFormFieldParams: EditFormFieldParams,
): ResultAsync<
  IPopulatedForm,
  EditFieldError | ReturnType<typeof transformMongoError>
> => {
  // TODO(#1210): Remove this function when no longer being called.
  if (
    [EditFieldActions.Create, EditFieldActions.Update].includes(
      editFormFieldParams.action.name,
    )
  ) {
    logger.info({
      message: 'deprecated editFormFields functions are still being used',
      meta: {
        action: 'editFormFields',
        fieldAction: editFormFieldParams.action.name,
        field: editFormFieldParams.field,
      },
    })
  }

  // TODO(#815): Split out this function into their own separate service functions depending on the update type.
  return getUpdatedFormFields(
    originalForm.form_fields,
    editFormFieldParams,
  ).asyncAndThen((newFormFields) => {
    // Update form fields of original form.
    originalForm.form_fields = newFormFields
    return ResultAsync.fromPromise(originalForm.save(), (error) => {
      logger.error({
        message: 'Error encountered while editing form fields',
        meta: {
          action: 'editFormFields',
          originalForm,
          editFormFieldParams,
        },
        error,
      })

      return transformMongoError(error)
    })
  })
}

/**
 * Updates form schema of given form depending on the given formUpdateParams
 * @param originalForm the original form to update form fields for
 * @param formUpdateParams the parameters to update the original form with
 *
 * @returns ok(updated form) if form fields update successfully
 * @returns err(set of DatabaseError) if any database errors occurs
 */
export const updateForm = (
  originalForm: IPopulatedForm,
  formUpdateParams: Except<FormUpdateParams, 'editFormField'>,
): ResultAsync<IPopulatedForm, ReturnType<typeof transformMongoError>> => {
  // TODO(#815): Split out this function into their own separate service functions depending on the form parameter to update.
  // Scrub formUpdateParams to remove private details, if any.
  const scrubbedFormParams = omit(formUpdateParams, [
    'admin',
    '__v',
    '_id',
    'id',
    'created',
    'lastModified',
  ])

  // Updating some part of form, override original form with new updated form.
  assignIn(originalForm, scrubbedFormParams)

  return ResultAsync.fromPromise(originalForm.save(), (error) => {
    logger.error({
      message: 'Error encountered while updating form',
      meta: {
        action: 'updateForm',
        originalForm,
        formUpdateParams,
      },
      error,
    })

    return transformMongoError(error)
  })
}

/**
 * Updates the collaborators of a given form
 * @param form the form to update collaborators fo
 * @param updatedCollaborators the new list of collaborators
 *
 * @returns ok(collaborators) if form updates successfully
 * @returns err(PossibleDatabaseError) if any database errors occurs
 * @returns err(InvalidCollaboratorError) if a newly-added collaborator email is not whitelisted
 */
export const updateFormCollaborators = (
  form: IPopulatedForm,
  updatedCollaborators: FormPermission[],
): ResultAsync<
  FormPermission[],
  PossibleDatabaseError | InvalidCollaboratorError
> => {
  const logMeta = {
    action: 'updateFormCollaborators',
    formId: form._id,
  }

  // Get the updated (added or modified) collaborator emails (i.e. they are not
  // in the original collaborator list).
  const updatedCollaboratorEmails = updatedCollaborators
    .filter(
      (c1) =>
        !form.permissionList.some(
          (c2) => c1.email === c2.email && c1.write === c2.write,
        ),
    )
    .map((collaborator) => collaborator.email)

  // find removed collaborators (i.e. collaborators in the original list)
  // but has been removed in the updated list
  const removedCollaboratorEmails = form.permissionList.filter((collaborator) =>
    updatedCollaborators.every(
      (newCollaborator) => collaborator.email !== newCollaborator.email,
    ),
  )

  return (
    ResultAsync.fromPromise(
      // Check that all updated collaborator domains exist in the Agency collection.
      Promise.all(
        updatedCollaboratorEmails.map(async (email) => {
          const emailDomain = email.split('@').pop()
          const result = await AgencyModel.findOne({ emailDomain })
          return !!result
        }),
      ),
      (error) => {
        logger.error({
          message: 'Error encountered while validating new form collaborators',
          meta: logMeta,
          error,
        })
        return transformMongoError(error)
      },
    )
      .andThen((doNewCollaboratorsExist) => {
        const falseIdx = doNewCollaboratorsExist.findIndex((exists) => !exists)
        return falseIdx < 0
          ? okAsync(undefined)
          : errAsync(
              new InvalidCollaboratorError(updatedCollaboratorEmails[falseIdx]),
            )
      })
      // after checking that collaborator exists
      // remove forms from workspaces for collaborators that were removed
      .andThen(() => {
        return ResultAsync.fromPromise(
          Promise.all(
            removedCollaboratorEmails.map(async (collaborator) => {
              await UserService.findUserByEmail(collaborator.email).map(
                async (user) =>
                  await removeFormsFromAllWorkspaces({
                    formIds: [form._id],
                    userId: user._id,
                  }),
              )
            }),
          ),
          (error) => {
            logger.error({
              message: 'Error encountered while removing forms from workspaces',
              meta: logMeta,
              error,
            })
            return transformMongoError(error)
          },
        )
      })
      .andThen(() =>
        ResultAsync.fromPromise(
          form.updateFormCollaborators(updatedCollaborators),
          (error) => {
            logger.error({
              message: 'Error encountered while updating form collaborators',
              meta: logMeta,
              error,
            })
            return transformMongoError(error)
          },
        ),
      )
      .andThen(({ permissionList }) => okAsync(permissionList))
  )
}

export const checkIsWhitelistSettingValid = (
  whitelistedSubmitterIds: string[] | null,
): { isValid: boolean; invalidReason?: string } => {
  if (!whitelistedSubmitterIds || whitelistedSubmitterIds.length <= 0) {
    return {
      isValid: true,
    }
  }

  // check for empty rows/entries
  const emptyRowIndex = whitelistedSubmitterIds.findIndex(
    (entry: string) => entry === '',
  )
  if (emptyRowIndex !== -1) {
    return {
      isValid: false,
      invalidReason: FORM_WHITELIST_CONTAINS_EMPTY_ROWS_ERROR_MESSAGE,
    }
  }

  // check for invalid NRIC/FIN/UEN format
  const invalidEntries = whitelistedSubmitterIds.filter((entry: string) => {
    return !(
      isNricValid(entry) ||
      isMFinSeriesValid(entry) ||
      isUenValid(entry)
    )
  })
  // check for invalid entries
  if (invalidEntries.length > 0) {
    return {
      isValid: false,
      invalidReason:
        FORM_WHITELIST_SETTING_CONTAINS_INVALID_FORMAT_SUBMITTERID_ERROR_MESSAGE(
          invalidEntries[0],
        ),
    }
  }

  // check for duplicates
  if (
    new Set(whitelistedSubmitterIds).size !== whitelistedSubmitterIds.length
  ) {
    return {
      isValid: false,
      invalidReason: FORM_WHITELIST_SETTING_CONTAINS_DUPLICATES_ERROR_MESSAGE,
    }
  }

  return {
    isValid: true,
  }
}

/**
 * Fetches the whitelist setting document without myPrivateKey for the client to use for decryption.
 */
export const getFormWhitelistSetting = (
  form: IPopulatedForm,
): ResultAsync<
  EncryptedStringsMessageContent | null,
  FormWhitelistSettingNotFoundError | PossibleDatabaseError
> => {
  const { isWhitelistEnabled, encryptedWhitelistedSubmitterIds } =
    form.getWhitelistedSubmitterIds()

  if (!isWhitelistEnabled) {
    return okAsync(null)
  }

  if (isWhitelistEnabled && !encryptedWhitelistedSubmitterIds) {
    return errAsync(new FormWhitelistSettingNotFoundError())
  }

  return ResultAsync.fromPromise(
    FormWhitelistedSubmitterIdsModel.findById(encryptedWhitelistedSubmitterIds)
      .lean()
      .exec()
      .then((whitelistSetting) =>
        pick(whitelistSetting, WHITELISTED_SUBMITTER_ID_DECRYPTION_FIELDS),
      ) as Promise<EncryptedStringsMessageContent>,
    (error) => {
      logger.error({
        message: 'Error encountered while retrieving form whitelist setting',
        meta: {
          action: 'getFormWhitelistSetting',
          formId: form._id,
        },
        error,
      })
      return transformMongoError(error)
    },
  ).andThen((whitelistSetting) => {
    if (!whitelistSetting) {
      return errAsync(new FormWhitelistSettingNotFoundError())
    }
    return okAsync(whitelistSetting)
  })
}

export const updateFormWhitelistSetting = (
  originalForm: IPopulatedForm,
  encryptedWhitelistedSubmitterIdsContent: EncryptedStringsMessageContentWithMyPrivateKey | null,
) => {
  if (originalForm.responseMode !== FormResponseMode.Encrypt) {
    return errAsync(
      new MalformedParametersError(
        'Whitelist setting does not exist for non-encrypt mode forms',
      ),
    )
  }

  const FormModelToUse = getFormModelByResponseMode(originalForm.responseMode)

  const updateFormWhitelistSettingPromise = async () => {
    const session = await FormModelToUse.startSession()
    session.startTransaction()

    if (encryptedWhitelistedSubmitterIdsContent) {
      // create whitelisted submitter id collection document and update reference to it
      const createdWhitelistedSubmitterIdsDocument =
        await FormWhitelistedSubmitterIdsModel.create({
          formId: originalForm._id,
          ...encryptedWhitelistedSubmitterIdsContent,
        })
      const updatedForm = await FormModelToUse.findByIdAndUpdate(
        originalForm._id,
        {
          whitelistedSubmitterIds: {
            isWhitelistEnabled: true,
            encryptedWhitelistedSubmitterIds:
              createdWhitelistedSubmitterIdsDocument._id,
          },
        },
        {
          new: true,
          runValidators: true,
        },
      ).exec()

      if (!updateForm) {
        await session.abortTransaction()
        return
      }

      await session.commitTransaction()
      await session.endSession()

      return updatedForm
    } else {
      // delete whitelisted submitter id collection document and update reference to null
      await FormWhitelistedSubmitterIdsModel.deleteMany({
        formId: originalForm._id,
      })
      const updatedForm = await FormModelToUse.findByIdAndUpdate(
        originalForm._id,
        {
          whitelistedSubmitterIds: {
            isWhitelistEnabled: false,
            encryptedWhitelistedSubmitterIds: undefined,
          },
        },
        { new: true, runValidators: true },
      ).exec()

      if (!updatedForm) {
        await session.abortTransaction()
        return
      }
      await session.commitTransaction()
      await session.endSession()
      return updatedForm
    }
  }

  return ResultAsync.fromPromise(
    updateFormWhitelistSettingPromise(),
    (error) => {
      logger.error({
        message: 'Error encountered while updating form whitelist setting',
        meta: {
          action: 'updateFormWhitelistSetting',
          formId: originalForm._id,
          // Body is not logged in case sensitive data such as emails are stored.
        },
        error,
      })
      return transformMongoError(error)
    },
  ).andThen((updatedForm) => {
    if (!updatedForm) {
      return errAsync(new FormNotFoundError())
    }
    return okAsync(updatedForm.getSettings())
  })
}

/**
 * Updates form settings.
 * @param originalForm The original form to update settings for
 * @param body the subset of form settings to update
 * @returns ok(updated form settings) on success
 * @returns err(MalformedParametersError) if auth type update is attempted for a multi-respondent form
 * @returns err(MalformedParametersError) if webhook update is attempted for a multi-respondent form
 * @returns err(database errors) if db error is thrown during form setting update
 */
export const updateFormSettings = (
  originalForm: IPopulatedForm,
  body: SettingsUpdateDto,
): ResultAsync<
  FormSettings,
  | MalformedParametersError
  | FormNotFoundError
  | DatabaseError
  | DatabaseValidationError
  | DatabaseConflictError
  | DatabasePayloadSizeError
> => {
  if (
    originalForm.responseMode === FormResponseMode.Multirespondent &&
    !!body.authType &&
    body.authType !== FormAuthType.NIL
  ) {
    return errAsync(new MalformedParametersError('Invalid authentication type'))
  }

  if (
    originalForm.responseMode === FormResponseMode.Multirespondent &&
    Boolean(body.webhook?.url)
  ) {
    return errAsync(
      new MalformedParametersError('Webhooks not supported on MRF'),
    )
  }

  // Don't allow emails updates or single response per submitterId
  // if payments_field is enabled on the form
  if (isFormEncryptMode(originalForm)) {
    if (
      (originalForm.payments_channel.channel !== PaymentChannel.Unconnected ||
        originalForm.payments_field.enabled) &&
      ((body as StorageFormSettings).emails || body.isSingleSubmission)
    ) {
      return errAsync(
        new MalformedParametersError(
          'Cannot update form settings when payments_field is enabled',
        ),
      )
    }
  }

  const dotifiedSettingsToUpdate = dotifyObject(body)
  const ModelToUse = getFormModelByResponseMode(originalForm.responseMode)

  return ResultAsync.fromPromise(
    ModelToUse.findByIdAndUpdate(originalForm._id, dotifiedSettingsToUpdate, {
      new: true,
      runValidators: true,
    }).exec(),
    (error) => {
      logger.error({
        message: 'Error encountered while updating form',
        meta: {
          action: 'updateFormSettings',
          formId: originalForm._id,
          // Body is not logged in case sensitive data such as emails are stored.
        },
        error,
      })

      return transformMongoError(error)
    },
  ).andThen((updatedForm) => {
    if (!updatedForm) {
      return errAsync(new FormNotFoundError())
    }
    return okAsync(updatedForm.getSettings())
  })
}

/**
 * Creates form logic.
 * @param form The original form to create logic in
 * @param createLogicBody Object containing the created logic
 * @returns ok(created logic dto) on success
 * @returns err(database errors) if db error is thrown during logic update
 */
export const createFormLogic = (
  form: IPopulatedForm,
  createLogicBody: LogicDto,
): ResultAsync<FormLogicSchema, DatabaseError | FormNotFoundError> => {
  // Create new form logic
  return ResultAsync.fromPromise(
    FormModel.createFormLogic(form._id, createLogicBody),
    (error) => {
      logger.error({
        message: 'Error occurred when creating form logic',
        meta: {
          action: 'createFormLogic',
          formId: form._id,
          createLogicBody,
        },
        error,
      })
      return transformMongoError(error)
    },
    // On success, return created form logic
  ).andThen((updatedForm) => {
    if (!updatedForm) {
      return errAsync(new FormNotFoundError())
    }
    const createdLogic = last(updatedForm.form_logics)
    return createdLogic ? okAsync(createdLogic) : errAsync(new DatabaseError())
  })
}

/**
 * Deletes form logic.
 * @param form The original form to delete logic in
 * @param logicId the logicId to delete
 * @returns ok(true) on success
 * @returns err(database errors) if db error is thrown during logic delete
 * @returns err(LogicNotFoundError) if logicId does not exist on form
 */
export const deleteFormLogic = (
  form: IPopulatedForm,
  logicId: string,
): ResultAsync<
  IFormDocument,
  DatabaseError | LogicNotFoundError | FormNotFoundError
> => {
  // First check if specified logic exists
  if (!form.form_logics.some((logic) => logic.id === logicId)) {
    logger.error({
      message: 'Error occurred - logicId to be deleted does not exist',
      meta: {
        action: 'deleteFormLogic',
        formId: form._id,
        logicId,
      },
    })
    return errAsync(new LogicNotFoundError())
  }

  // Remove specified logic and then update form logic
  return ResultAsync.fromPromise(
    FormModel.deleteFormLogic(String(form._id), logicId),
    (error) => {
      logger.error({
        message: 'Error occurred when deleting form logic',
        meta: {
          action: 'deleteFormLogic',
          formId: form._id,
          logicId,
        },
        error,
      })
      return transformMongoError(error)
    },
    // On success, return true
  ).andThen((updatedForm) => {
    if (!updatedForm) {
      return errAsync(new FormNotFoundError())
    }
    return okAsync(updatedForm)
  })
}

/**
 * Updates form logic.
 * @param form The original form to update logic in
 * @param logicId the logicId to update
 * @param updatedLogic Object containing the updated logic
 * @returns ok(updated logic dto) on success
 * @returns err(database errors) if db error is thrown during logic update
 * @returns err(LogicNotFoundError) if logicId does not exist on form
 */
export const updateFormLogic = (
  form: IPopulatedForm,
  logicId: string,
  updatedLogic: LogicDto,
): ResultAsync<
  FormLogicSchema,
  DatabaseError | LogicNotFoundError | FormNotFoundError
> => {
  // First check if specified logic exists
  if (!form.form_logics.some((logic) => logic._id.toHexString() === logicId)) {
    logger.error({
      message: 'Error occurred - logicId to be updated does not exist',
      meta: {
        action: 'updateFormLogic',
        formId: form._id,
        logicId,
      },
    })
    return errAsync(new LogicNotFoundError())
  }

  // Update specified logic
  return ResultAsync.fromPromise(
    FormModel.updateFormLogic(form._id.toHexString(), logicId, updatedLogic),
    (error) => {
      logger.error({
        message: 'Error occurred when updating form logic',
        meta: {
          action: 'updateFormLogic',
          formId: form._id,
          logicId,
          updatedLogic,
        },
        error,
      })
      return transformMongoError(error)
    },
    // On success, return updated form logic
  ).andThen((updatedForm) => {
    if (!updatedForm) {
      return errAsync(new FormNotFoundError())
    }
    const updatedLogic = getLogicById(updatedForm.form_logics, logicId)
    return updatedLogic
      ? okAsync(updatedLogic)
      : errAsync(new LogicNotFoundError()) // Possible race condition if logic gets deleted after the initial logicId check but before the db update
  })
}

/**
 * Deletes a form field from the given form.
 * @param form The form to delete the specified form field for
 * @param fieldId the id of the form field to delete
 * @returns ok(updated form) on success
 * @returns err(PossibleDatabaseError) if db error is thrown during the deletion of form fields
 * @returns err(FieldNotFoundError) if the fieldId does not exist in form's fields
 */
export const deleteFormField = <T extends IFormSchema>(
  form: T,
  fieldId: string,
): ResultAsync<
  IFormSchema,
  PossibleDatabaseError | FormNotFoundError | FieldNotFoundError
> => {
  const logMeta = {
    action: 'deleteFormField',
    formId: form._id,
    fieldId,
  }

  if (!getFormFieldById(form.form_fields, fieldId)) {
    logger.error({
      message: 'Field to be deleted cannot be found',
      meta: logMeta,
    })
    return errAsync(new FieldNotFoundError())
  }

  return ResultAsync.fromPromise(
    FormModel.deleteFormFieldById(String(form._id), fieldId),
    (error) => {
      logger.error({
        message: 'Error occurred when deleting form logic',
        meta: logMeta,
        error,
      })
      return transformMongoError(error)
    },
  ).andThen((updatedForm) => {
    if (!updatedForm) {
      return errAsync(new FormNotFoundError())
    }
    return okAsync(updatedForm)
  })
}

/**
 * Update the end page of the given form
 * @param formId the id of the form to update the end page for
 * @param newEndPage the new end page object to replace the current one
 * @returns ok(updated end page object) when update is successful
 * @returns err(FormNotFoundError) if form cannot be found
 * @returns err(PossibleDatabaseError) if endpage update fails
 */
export const updateEndPage = (
  formId: string,
  newEndPage: EndPageUpdateDto,
): ResultAsync<
  IFormDocument['endPage'],
  PossibleDatabaseError | FormNotFoundError
> => {
  return ResultAsync.fromPromise(
    FormModel.updateEndPageById(formId, newEndPage),
    (error) => {
      logger.error({
        message: 'Error occurred when updating form end page',
        meta: {
          action: 'updateEndPage',
          formId,
          newEndPage,
        },
        error,
      })
      return transformMongoError(error)
    },
  ).andThen((updatedForm) => {
    if (!updatedForm) {
      return errAsync(new FormNotFoundError())
    }
    return okAsync(updatedForm.endPage)
  })
}

/**
 * Retrieves a form field from the given form.
 * @param form The form to retrieve the specified form field for
 * @param fieldId the id of the form field
 * @returns ok(form field) on success
 * @returns err(FieldNotFoundError) if the fieldId does not exist in form's fields
 */
export const getFormField = (
  form: IPopulatedForm,
  fieldId: string,
): Result<FormFieldSchema, FieldNotFoundError> => {
  const formField = getFormFieldById(form.form_fields, fieldId)
  if (!formField)
    return err(
      new FieldNotFoundError(
        `Attempted to retrieve field ${fieldId} from ${form._id} but field was not present`,
      ),
    )
  return ok(formField)
}

/**
 * Update the start page of the given form
 * @param formId the id of the form to update the end page for
 * @param newStartPage the new start page object to replace the current one
 * @returns ok(updated start page object) when update is successful
 * @returns err(FormNotFoundError) if form cannot be found
 * @returns err(PossibleDatabaseError) if start page update fails
 */
export const updateStartPage = (
  formId: string,
  newStartPage: StartPageUpdateDto,
): ResultAsync<
  IFormDocument['startPage'],
  PossibleDatabaseError | FormNotFoundError
> => {
  return ResultAsync.fromPromise(
    FormModel.updateStartPageById(formId, newStartPage),
    (error) => {
      logger.error({
        message: 'Error occurred when updating form start page',
        meta: {
          action: 'updateStartPage',
          formId,
          newStartPage,
        },
        error,
      })
      return transformMongoError(error)
    },
  ).andThen((updatedForm) => {
    if (!updatedForm) {
      return errAsync(new FormNotFoundError())
    }
    return okAsync(updatedForm.startPage)
  })
}

/**
 * Creates msgSrvcName and updates the form in MongoDB as part of a transaction, uses the created
 * msgSrvcName as the key to store the Twilio Credentials in AWS Secrets Manager
 * @param twilioCredentials The twilio credentials to add
 * @param form The form to add Twilio Credentials
 * @returns ok(undefined) if the creation is successful
 * @returns err(SecretsManagerError) if an error occurs while creating credentials in secrets manager
 */
export const createTwilioCredentials = (
  twilioCredentials: TwilioCredentials,
  form: IPopulatedForm,
): ResultAsync<
  unknown,
  ReturnType<typeof transformMongoError> | SecretsManagerError
> => {
  const twilioCredentialsData: TwilioCredentialsData =
    new TwilioCredentialsData(twilioCredentials)
  const formId = form._id

  const msgSrvcName = generateTwilioCredSecretKeyName(formId)

  const body: CreateSecretRequest = {
    Name: msgSrvcName,
    SecretString: twilioCredentialsData.toString(),
    Description: `autogenerated via API on ${new Date().toISOString()} by ${
      form.admin._id
    }`,
  }

  const logMeta = {
    action: 'createTwilioCredentials',
    formId: formId,
    msgSrvcName,
    body,
  }

  logger.info({
    message: `No msgSrvcName, creating Twilio credentials for form ${formId}`,
    meta: logMeta,
  })

  return ResultAsync.fromPromise(
    FormModel.startSession().then((session: ClientSession) =>
      session
        .withTransaction(() =>
          createTwilioTransaction(form, msgSrvcName, body, session),
        )
        .then(() => session.endSession()),
    ),
    (error) => {
      logger.error({
        message: 'Error encountered when creating Twilio Secret',
        meta: logMeta,
        error,
      })

      return error as
        | ReturnType<typeof transformMongoError>
        | SecretsManagerError
    },
  )
}

/**
 * Updates msgSrvcName of the form in the database, uses the msgSrvcName as the
 * key to store the Twilio Credentials in AWS Secrets Manager
 * @param form The form to add Twilio Credentials
 * @param msgSrvcName The key under which the credentials is stored in AWS Secrets Manager
 * @param body the request body used to create the secret in secrets manager
 * @param session session of the transaction
 * @returns Promise.ok(void) if the creation is successful
 */
// Exported to use in tests
export const createTwilioTransaction = async (
  form: IPopulatedForm,
  msgSrvcName: string,
  body: CreateSecretRequest,
  session: ClientSession,
): Promise<void> => {
  const meta = {
    action: 'createTwilioTransaction',
    formId: form._id,
    msgSrvcName,
    body,
  }

  try {
    await form.updateMsgSrvcName(msgSrvcName, session)
  } catch (err) {
    logger.error({
      message:
        'Error occured when updating msgSrvcName, rolling back transaction!',
      meta,
      error: err,
    })
    throw transformMongoError(err)
  }

  try {
    await secretsManager.createSecret(body).promise()
  } catch (err) {
    const awsError = err as AWSError

    logger.error({
      message:
        'Error occured when creating secret AWS Secrets Manager, rolling back transaction!',
      meta,
      error: awsError,
    })
    throw new SecretsManagerError(awsError.message)
  }
}

/**
 * Uses the msgSrvcName to update the Twilio Credentials in AWS Secrets Manager
 * Clears the cache entry in which the Twilio Credentials are stored under
 * @param twilioCredentials The twilio credentials to add
 * @param msgSrvcName The key under which the credentials are stored in Secrets Manager
 * @returns ok(number) if the update is successful
 * @returns err(SecretsManagerNotFoundError) if there is no secret stored under msgSrvcName in secrets manager
 * @returns err(SecretsManagerError) if an error occurs while updating credentials in secrets manager
 */
export const updateTwilioCredentials = (
  msgSrvcName: string,
  twilioCredentials: TwilioCredentials,
): ResultAsync<
  number,
  SecretsManagerError | SecretsManagerNotFoundError | TwilioCacheError
> => {
  const twilioCredentialsData: TwilioCredentialsData =
    new TwilioCredentialsData(twilioCredentials)

  const body: PutSecretValueRequest = {
    SecretId: msgSrvcName,
    SecretString: twilioCredentialsData.toString(),
  }

  const logMeta = {
    action: 'updateTwilioCredentials',
    msgSrvcName,
    body,
  }

  return (
    ResultAsync.fromPromise(
      secretsManager.getSecretValue({ SecretId: msgSrvcName }).promise(),
      (error) => {
        const awsError = error as AWSError

        if (awsError.code === 'ResourceNotFoundException') {
          logger.error({
            message: 'Twilio Credentials do not exist in Secrets Manager',
            meta: logMeta,
            error,
          })

          return new SecretsManagerNotFoundError(awsError.message)
        }

        logger.error({
          message: 'Error occurred when retrieving Twilio in Secret Manager!',
          meta: {
            ...logMeta,
            body,
          },
          error,
        })

        return new SecretsManagerError(awsError.message)
      },
    )
      .andThen(() => {
        logger.info({
          message: 'Twilio Credentials has been found in Secrets Manager',
          meta: logMeta,
        })

        return ResultAsync.fromPromise(
          secretsManager.putSecretValue(body).promise(),
          (error) => {
            logger.error({
              message: 'Error occurred when updating Twilio in Secret Manager!',
              meta: {
                ...logMeta,
                body,
              },
              error,
            })

            return new SecretsManagerError(
              'Error occurred when updating Twilio in Secret Manager!',
            )
          },
        )
      })
      // Currently, a call to get twilio credentials will cache the credentials in the twilioCache for ~10s
      // If a call to retrieve twilio credentials occurs before 10s passes, it will be a cache hit, retrieving
      // the wrong credentials. Hence we need to clear the cache entry
      .map(() => twilioClientCache.del(msgSrvcName))
  )
}

/**
 * Uses the msgSrvcName to schedule the Twilio Credentials for deletion in AWS Secrets Manager and removes
 * msgSrvcName from the form in MongoDB as part of a transaction
 *
 * Clears the cache entry in which the Twilio Credentials are stored under
 * @param form The form to delete Twilio Credentials
 * @param msgSrvcName The key under which the credentials are stored in Secrets Manager
 * @returns ok(number) if the deletion is successful
 * @returns err(SecretsManagerNotFoundError) if there is no secret stored under msgSrvcName in secrets manager
 * @returns err(SecretsManagerError) if an error occurs while deleting credentials in secrets manager
 */
export const deleteTwilioCredentials = (
  form: IPopulatedForm,
): ResultAsync<
  unknown,
  | ReturnType<typeof transformMongoError>
  | SecretsManagerError
  | TwilioCacheError
> => {
  if (!form.msgSrvcName) return okAsync(null)

  const msgSrvcName = form.msgSrvcName
  const body: DeleteSecretRequest = {
    SecretId: msgSrvcName,
  }
  /**
   *
   * The key-value pair will remain in SecretsManager for another 30 days before
   * being deleted: https://docs.aws.amazon.com/secretsmanager/latest/userguide/manage_delete-secret.html
   *
   */

  const formId = form._id

  const logMeta = {
    action: 'deleteTwilioCredentials',
    formId,
    msgSrvcName,
    body,
  }

  return ResultAsync.fromPromise(
    FormModel.startSession().then((session: ClientSession) =>
      session
        .withTransaction(() => deleteTwilioTransaction(form, body, session))
        .then(() => session.endSession()),
    ),
    (error) => {
      logger.error({
        message: 'Error occurred when deleting Twilio in Secret Manager!',
        meta: logMeta,
        error,
      })

      return error as
        | ReturnType<typeof transformMongoError>
        | SecretsManagerError
    },
  ).map(() => twilioClientCache.del(msgSrvcName))
}

/**
 * Deletes the msgSrvcName of the specified form in the database and uses the msgSrvcName as the
 * key to delete the Twilio Credentials in AWS Secrets Manager
 * @param form The form to delete Twilio Credentials
 * @param msgSrvcName The key under which the credentials is stored in AWS Secrets Manager
 * @param body the request body used to delete the secret in secrets manager
 * @param session session of the transaction
 * @returns Promise.ok(void) if the creation is successful
 */
const deleteTwilioTransaction = async (
  form: IPopulatedForm,
  body: DeleteSecretRequest,
  session: ClientSession,
): Promise<void> => {
  const msgSrvcName = body.SecretId
  const meta = {
    action: 'deleteTwilioTransaction',
    formId: form._id,
    msgSrvcName,
    body,
  }

  try {
    await form.deleteMsgSrvcName(session)
  } catch (err) {
    logger.error({
      message:
        'Error occured when deleting msgSrvcName in MongoDB, rolling back transaction!',
      meta,
      error: err,
    })
    throw transformMongoError(err)
  }

  try {
    if (checkIsApiSecretKeyName(msgSrvcName))
      await secretsManager.deleteSecret(body).promise()
  } catch (err) {
    const awsError = err as AWSError
    logger.error({
      message:
        'Error occured when deleting secret key in AWS Secrets Manager, rolling back transaction!',
      meta,
      error: awsError,
    })
    throw new SecretsManagerError(awsError.message)
  }
}

export const archiveForms = async ({
  formIds,
  session,
  admin,
}: {
  formIds: string[]
  admin: string
  session: ClientSession
}): Promise<void> => {
  const canBeArchivedForms = await FormModel.find({
    _id: { $in: formIds },
    admin,
  })
  const canBeArchivedFormIds = canBeArchivedForms.map((form) => form._id)

  await FormModel.archiveForms(canBeArchivedFormIds, session)
}

export const getGoLinkSuffix = (formId: string) => {
  return ResultAsync.fromPromise(FormModel.getGoLinkSuffix(formId), (error) => {
    logger.error({
      message: 'Error occurred when retrieving go link suffix',
      meta: {
        action: 'getGoLinkSuffix',
        formId,
      },
      error,
    })
    return transformMongoError(error)
  })
}

export const setGoLinkSuffix = (formId: string, linkSuffix: string) => {
  return ResultAsync.fromPromise(
    FormModel.setGoLinkSuffix(formId, linkSuffix),
    (error) => {
      logger.error({
        message: 'Error occurred when setting go link suffix',
        meta: {
          action: 'setGoLinkSuffix',
          formId,
        },
        error,
      })
      return transformMongoError(error)
    },
  )
}
