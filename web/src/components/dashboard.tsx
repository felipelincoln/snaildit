import { useCallback, useEffect, useState } from 'react'
import { CircleNotchIcon, PencilSimpleIcon, TrashIcon, WarningIcon } from '@phosphor-icons/react'
import { Activity } from '@/components/activity'
import { AutomationDialog } from '@/components/automation-dialog'
import { RecentRuns } from '@/components/recent-runs'
import { TriggerIcon } from '@/components/trigger-icon'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import { Switch } from '@/components/ui/switch'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import {
  type Automation,
  type Repo,
  type State,
  deleteAutomation,
  getAutomations,
  getEngines,
  getRepos,
  updateAutomation,
} from '@/lib/api'

function AutomationRow({
  automation,
  connected,
  onEdit,
  onChanged,
  onError,
}: {
  automation: Automation
  connected: boolean
  onEdit: () => void
  onChanged: () => void
  onError: (message: string | null) => void
}) {
  const [busy, setBusy] = useState(false)
  const n = automation.triggers.length
  const toggle = async (enabled: boolean) => {
    setBusy(true)
    try {
      await updateAutomation(automation.id, { enabled })
      onError(null)
    } catch (err) {
      onError((err as Error).message)
    } finally {
      setBusy(false)
      onChanged()
    }
  }
  return (
    <div
      className={`group relative flex min-h-10 items-center gap-3 rounded-md px-2 py-2 transition-colors hover:bg-accent ${automation.enabled ? '' : 'opacity-50'}`}
    >
      <button
        type="button"
        onClick={onEdit}
        className="flex min-w-0 flex-1 items-center gap-3 rounded-md text-left outline-none after:absolute after:inset-0 after:content-[''] focus-visible:ring-2 focus-visible:ring-ring"
      >
        <TriggerIcon event={automation.triggers[0]?.event ?? ''} />
        <span className="max-w-56 shrink-0 truncate text-sm">{automation.name}</span>
        <span className="min-w-0 truncate font-mono text-xs text-muted-foreground">{automation.trigger_repo}</span>
        {!connected && (
          <Tooltip>
            <TooltipTrigger asChild>
              <WarningIcon aria-label="Repository not connected" className="size-3.5 shrink-0 text-destructive" />
            </TooltipTrigger>
            <TooltipContent>Repository not connected</TooltipContent>
          </Tooltip>
        )}
      </button>

      <div className="relative z-10 flex shrink-0 items-center">
        <div className="flex items-center gap-2 group-hover:hidden group-focus-within:hidden">
          {!automation.enabled && (
            <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">Off</span>
          )}
          <span className="text-xs text-muted-foreground tabular-nums">
            {n} trigger{n === 1 ? '' : 's'}
          </span>
        </div>
        <div className="hidden items-center gap-0.5 group-hover:flex group-focus-within:flex">
          <Switch checked={automation.enabled} onCheckedChange={toggle} disabled={busy} aria-label="Enabled" />
          <Button type="button" variant="ghost" size="icon-xs" onClick={onEdit} aria-label="Edit automation">
            <PencilSimpleIcon />
          </Button>
          <DeleteAutomation
            name={automation.name}
            onConfirm={() =>
              deleteAutomation(automation.id)
                .then(
                  () => onError(null),
                  (err: unknown) => onError((err as Error).message),
                )
                .finally(onChanged)
            }
          />
        </div>
      </div>
    </div>
  )
}

function DeleteAutomation({ name, onConfirm }: { name: string; onConfirm: () => void }) {
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label="Delete automation"
          className="text-muted-foreground hover:text-destructive"
        >
          <TrashIcon />
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete this automation?</AlertDialogTitle>
          <AlertDialogDescription>“{name}” will be removed. This can't be undone.</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={onConfirm}>
            Delete
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

export function Dashboard({ state, createNew }: { state: State; createNew: number }) {
  const [automations, setAutomations] = useState<Automation[] | null>(null)
  const [repos, setRepos] = useState<Repo[] | null>(null)
  const [efforts, setEfforts] = useState<string[]>([])
  const [form, setForm] = useState<Automation | 'new' | null>(null)
  const [loadFailed, setLoadFailed] = useState(false)
  const [reposFailed, setReposFailed] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)

  const load = useCallback(() => {
    void getAutomations()
      .then((r) => {
        setAutomations(r.automations)
        setLoadFailed(false)
      })
      .catch(() => setLoadFailed(true))
  }, [])

  const loadRepos = useCallback(() => {
    void getRepos()
      .then((r) => {
        setRepos(r.repos)
        setReposFailed(false)
      })
      .catch(() => setReposFailed(true))
  }, [])

  useEffect(() => {
    load()
    loadRepos()
    void getEngines()
      .then((r) => setEfforts((r.engines.find((e) => e.configured) ?? r.engines[0])?.efforts ?? []))
      .catch(() => {})
  }, [load, loadRepos, state.domains.repos.done, state.domains.engine.done])

  useEffect(() => {
    if (createNew > 0) setForm('new')
  }, [createNew])

  if (automations == null) {
    if (loadFailed)
      return (
        <div className="w-full max-w-3xl">
          <Alert variant="destructive">
            <WarningIcon />
            <AlertTitle>Couldn't load your automations</AlertTitle>
            <AlertDescription>
              <Button size="sm" variant="outline" onClick={load}>
                Retry
              </Button>
            </AlertDescription>
          </Alert>
        </div>
      )
    return (
      <CircleNotchIcon
        role="status"
        aria-label="Loading automations"
        className="size-6 animate-spin text-muted-foreground"
      />
    )
  }

  return (
    <div className="w-full max-w-3xl">
      <Activity />

      {actionError && (
        <Alert variant="destructive" className="mb-4">
          <WarningIcon />
          <AlertTitle>Action failed</AlertTitle>
          <AlertDescription>{actionError}</AlertDescription>
        </Alert>
      )}

      {automations.length > 0 && (
        <div className="flex flex-col gap-2">
          <h2 className="text-base font-normal tracking-tight">Automations</h2>
          <Separator />
          <div className="-mx-2 flex flex-col">
            {automations.map((a) => (
              <AutomationRow
                key={a.id}
                automation={a}
                connected={repos === null || repos.some((r) => r.id === a.trigger_repo_id)}
                onEdit={() => setForm(a)}
                onChanged={load}
                onError={setActionError}
              />
            ))}
          </div>
        </div>
      )}

      <RecentRuns />

      {form && (
        <AutomationDialog
          repos={repos ?? []}
          reposFailed={reposFailed}
          onRetryRepos={loadRepos}
          efforts={efforts}
          automation={form === 'new' ? undefined : form}
          onClose={() => setForm(null)}
          onSaved={() => {
            setForm(null)
            load()
          }}
        />
      )}
    </div>
  )
}
