import { useEffect, useState } from 'react'
import { WarningIcon } from '@phosphor-icons/react'
import { AppPanel } from '@/components/setup/app-panel'
import { EnginePanel } from '@/components/setup/engine-panel'
import { ReposPanel } from '@/components/setup/repos-panel'
import { Alert } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { retryWebhook } from '@/lib/api'
import type { DomainId, State } from '@/lib/api'

type CoreDomain = 'app' | 'repos' | 'engine'

const META: Record<CoreDomain, { row: string; title: string; description: string }> = {
  app: {
    row: "Your bot can't reach GitHub.",
    title: 'Reconnect your bot',
    description: 'Re-create the GitHub App so the bot can act on your repositories.',
  },
  repos: {
    row: 'No repositories are connected.',
    title: 'Connect repositories',
    description: 'Choose which repositories your bot can act on.',
  },
  engine: {
    row: 'The engine needs to be reconnected.',
    title: 'Reconnect the engine',
    description: 'Log in again so your automations can run.',
  },
}

const CORE: CoreDomain[] = ['app', 'repos', 'engine']

export function HealthBanner({ state, refresh }: { state: State; refresh: () => Promise<void> }) {
  const [fixing, setFixing] = useState<CoreDomain | null>(null)
  const down = CORE.filter((id) => !state.domains[id].done)
  const broken = down.includes('app') ? down.filter((id) => id !== 'repos') : down
  const webhookDown =
    state.domains.app.done && (state.webhook.status === 'failed' || state.webhook.status === 'retrying')

  useEffect(() => {
    if (fixing && !broken.includes(fixing)) setFixing(null)
  }, [fixing, broken])

  if (broken.length === 0 && !webhookDown) return null

  return (
    <>
      <div className="mb-4 flex flex-col gap-2">
        {broken.map((id) => (
          <Alert key={id} variant="destructive" className="flex items-center gap-3">
            <WarningIcon className="shrink-0" />
            <span className="min-w-0 flex-1 truncate">{META[id].row}</span>
            <Button size="sm" variant="outline" onClick={() => setFixing(id)}>
              Fix
            </Button>
          </Alert>
        ))}
        {webhookDown && <WebhookRow refresh={refresh} />}
      </div>
      <Dialog
        open={fixing != null}
        onOpenChange={(open) => {
          if (!open) setFixing(null)
        }}
      >
        <DialogContent>
          {fixing && (
            <>
              <DialogHeader>
                <DialogTitle>{META[fixing].title}</DialogTitle>
                <DialogDescription>{META[fixing].description}</DialogDescription>
              </DialogHeader>
              <div className="flex min-w-0 flex-col gap-6">
                <FixPanel domain={fixing} state={state} refresh={refresh} />
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </>
  )
}

function WebhookRow({ refresh }: { refresh: () => Promise<void> }) {
  const [retrying, setRetrying] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const onRetry = async () => {
    setRetrying(true)
    setError(null)
    try {
      await retryWebhook()
      await refresh()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setRetrying(false)
    }
  }
  return (
    <Alert variant="destructive" className="flex items-center gap-3">
      <WarningIcon className="shrink-0" />
      <span className="min-w-0 flex-1 truncate">The bot can't receive GitHub events.{error ? ` — ${error}` : ''}</span>
      <Button size="sm" variant="outline" disabled={retrying} onClick={() => void onRetry()}>
        {retrying ? 'Retrying…' : 'Retry'}
      </Button>
    </Alert>
  )
}

function FixPanel({ domain, state, refresh }: { domain: DomainId; state: State; refresh: () => Promise<void> }) {
  switch (domain) {
    case 'app':
      return <AppPanel />
    case 'repos':
      return <ReposPanel appSlug={state.appSlug} />
    case 'engine':
      return <EnginePanel engine={state.engine} onAdvance={() => void refresh()} />
    default:
      return null
  }
}
