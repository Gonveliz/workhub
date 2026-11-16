import { prName } from '@workhub/core'
import { Button } from '../../components/atoms'
import { Dialog } from '../../components/molecules'
import { useI18n } from '../../i18n/I18nProvider'
import type { IntentOutcome } from '../../lib/links'

export type PrPromptOffer = Extract<IntentOutcome, { kind: 'offer' }>

/**
 * "Fix CI" or "Address review comments" found no session linked to the pull request: asks before
 * one starts in the PR's repository folder with the request. Nothing starts or is sent without "Start and send".
 */
export function PrPromptOfferDialog({ offer, onClose, onStart }: { offer: PrPromptOffer | null; onClose: () => void; onStart: (offer: PrPromptOffer) => void }) {
  const { t } = useI18n()
  if (!offer) return null
  const { pr } = offer.intent
  const params = { folder: offer.folder, branch: pr.branch }
  return (
    <Dialog
      open
      onOpenChange={(open) => !open && onClose()}
      title={t('prFeedback.offer.title', { name: prName(pr, pr.provider) })}
      description={t(offer.onBranch ? 'prFeedback.offer.body' : 'prFeedback.offer.bodyOtherBranch', params)}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" onClick={() => onStart(offer)}>
            {t('prFeedback.offer.start')}
          </Button>
        </>
      }
    >
      {null}
    </Dialog>
  )
}
