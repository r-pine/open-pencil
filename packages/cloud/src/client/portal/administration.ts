import {
  adminAuditResponseSchema,
  adminEmailResponseSchema,
  adminMutationResponseSchema,
  adminOperationsResponseSchema,
  cloudAdminSessionResponseSchema,
  cloudAdminUsersResponseSchema,
  enrollmentReviewResponseSchema,
  enrollmentsResponseSchema,
  type enrollmentStatusSchema
} from '#cloud/contract'
import type * as v from 'valibot'

import type { CloudCall, PortalRouteClients } from './request'

type EnrollmentStatus = v.InferOutput<typeof enrollmentStatusSchema>

export function createAdministrationAPI(call: CloudCall, { admin, api }: PortalRouteClients) {
  return {
    session(signal?: AbortSignal) {
      return call(
        (options) => api.session.$get(undefined, options),
        cloudAdminSessionResponseSchema,
        signal
      )
    },
    enrollments(status?: EnrollmentStatus, signal?: AbortSignal) {
      return call(
        (options) => admin.enrollments.$get({ query: { status } }, options),
        enrollmentsResponseSchema,
        signal
      )
    },
    reviewEnrollment(
      id: string,
      action: 'approve' | 'reject' | 'revoke',
      note?: string,
      signal?: AbortSignal
    ) {
      return call(
        (options) =>
          admin.enrollments[':id'][action].$post({ param: { id }, json: { note } }, options),
        enrollmentReviewResponseSchema,
        signal
      )
    },
    users(search?: string, signal?: AbortSignal) {
      return call(
        (options) => admin.users.$get({ query: { search: search || undefined } }, options),
        cloudAdminUsersResponseSchema,
        signal
      )
    },
    userAction(
      action: 'ban' | 'unban' | 'revoke-sessions',
      userId: string,
      reason?: string,
      signal?: AbortSignal
    ) {
      return call(
        (options) => admin.users[action].$post({ json: { userId, reason } }, options),
        adminMutationResponseSchema,
        signal
      )
    },
    setAdmin(userId: string, enabled: boolean, signal?: AbortSignal) {
      return call(
        (options) => admin.users['set-admin'].$post({ json: { userId, enabled } }, options),
        adminMutationResponseSchema,
        signal
      )
    },
    email(signal?: AbortSignal) {
      return call(
        (options) => admin.email.$get({ query: {} }, options),
        adminEmailResponseSchema,
        signal
      )
    },
    regenerateEmail(id: string, signal?: AbortSignal) {
      return call(
        (options) => admin.email[':id'].regenerate.$post({ param: { id } }, options),
        adminMutationResponseSchema,
        signal
      )
    },
    audit(signal?: AbortSignal) {
      return call(
        (options) => admin.audit.$get({ query: {} }, options),
        adminAuditResponseSchema,
        signal
      )
    },
    operations(signal?: AbortSignal) {
      return call(
        (options) => admin.operations.$get(undefined, options),
        adminOperationsResponseSchema,
        signal
      )
    }
  }
}
