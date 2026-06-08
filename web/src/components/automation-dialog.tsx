import { type FormEvent, useState } from 'react'
import { CaretDownIcon, CircleNotchIcon, GaugeIcon, ListChecksIcon } from '@phosphor-icons/react'
import { GithubIcon } from '@/components/github-icon'
import { TriggerIcon } from '@/components/trigger-icon'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import {
  type Automation,
  type AutomationUpdate,
  type Repo,
  EVENT_ACTIONS,
  EVENT_TYPES,
  createAutomation,
  updateAutomation,
} from '@/lib/api'

function slugify(s: string): string {
  return s
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

export function AutomationDialog({
  repos,
  efforts,
  automation,
  onClose,
  onSaved,
}: {
  repos: Repo[]
  efforts: string[]
  automation?: Automation
  onClose: () => void
  onSaved: () => void
}) {
  const repoOptions =
    automation && !repos.some((r) => r.id === automation.trigger_repo_id)
      ? [{ id: automation.trigger_repo_id, full_name: automation.trigger_repo }, ...repos]
      : repos

  const [name, setName] = useState(automation?.name ?? '')
  const [repoId, setRepoId] = useState(
    automation ? String(automation.trigger_repo_id) : repoOptions[0] ? String(repoOptions[0].id) : '',
  )
  const [event, setEvent] = useState(automation?.trigger_event ?? '')
  const [actions, setActions] = useState<string[]>(automation?.trigger_actions ?? [])
  const [prompt, setPrompt] = useState(automation?.prompt ?? '')
  const defaultEffort = efforts.includes('medium') ? 'medium' : (efforts[0] ?? '')
  const [effort, setEffort] = useState(automation ? (automation.effort ?? '') : defaultEffort)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const id = automation ? automation.id : slugify(name)
  const canSave = id !== '' && repoId !== '' && event !== '' && actions.length > 0 && prompt.trim() !== '' && !busy

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    const selectedRepo = repoOptions.find((r) => String(r.id) === repoId)
    const fields = {
      name: name.trim(),
      prompt: prompt.trim(),
      trigger_repo_id: Number(repoId),
      trigger_repo: selectedRepo?.full_name ?? '',
      trigger_event: event,
      trigger_actions: actions,
    }
    try {
      if (automation) {
        const patch: AutomationUpdate = { ...fields }
        if (effort !== (automation.effort ?? '')) patch.effort = effort || undefined
        await updateAutomation(automation.id, patch)
      } else {
        await createAutomation({ id, ...fields, effort: effort || undefined })
      }
      onSaved()
    } catch (err) {
      setError((err as Error).message)
      setBusy(false)
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{automation ? 'Edit automation' : 'New automation'}</DialogTitle>
          <DialogDescription>A trigger plus a prompt your bot runs.</DialogDescription>
        </DialogHeader>

        <form onSubmit={submit} className="flex min-w-0 flex-col gap-3">
          <Input
            aria-label="Name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Name, e.g. PR review"
          />

          <Textarea
            aria-label="Prompt"
            className="max-h-64 min-h-28 overflow-y-auto"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="What should the bot do? e.g. Review this pull request and leave inline comments."
          />

          <div className="flex flex-col gap-2">
            <span className="text-xs text-muted-foreground">Trigger events</span>
            <div className="flex flex-wrap items-center gap-2">
              <Select
                value={event}
                onValueChange={(v) => {
                  setEvent(v)
                  setActions([])
                }}
              >
                <SelectTrigger size="sm" aria-label="On event" className="gap-2">
                  <TriggerIcon event={event} className="size-4 shrink-0 text-muted-foreground" />
                  <SelectValue placeholder="On event" />
                </SelectTrigger>
                <SelectContent>
                  {EVENT_TYPES.map((ev) => (
                    <SelectItem key={ev} value={ev}>
                      {ev}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>

              {event && EVENT_ACTIONS[event] && (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button type="button" variant="outline" size="sm" aria-label="Actions" className="gap-2">
                      <ListChecksIcon className="size-4 shrink-0 text-muted-foreground" />
                      {actions.length > 0 ? (
                        `${actions.length} selected`
                      ) : (
                        <span className="text-muted-foreground">Actions</span>
                      )}
                      <CaretDownIcon className="size-4 shrink-0 text-muted-foreground" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start" className="max-h-72 overflow-y-auto">
                    {EVENT_ACTIONS[event].map((a) => (
                      <DropdownMenuCheckboxItem
                        key={a}
                        checked={actions.includes(a)}
                        onCheckedChange={(checked) =>
                          setActions(checked ? [...actions, a] : actions.filter((x) => x !== a))
                        }
                        onSelect={(e) => e.preventDefault()}
                      >
                        {a}
                      </DropdownMenuCheckboxItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
            </div>
          </div>

          {error && <p className="text-xs text-destructive">{error}</p>}

          <DialogFooter className="-mx-6 -mb-6 mt-1 items-center rounded-b-lg bg-black/20 px-6 py-4">
            <div className="mr-auto flex min-w-0 items-center gap-2">
              <Select value={repoId} onValueChange={setRepoId}>
                <SelectTrigger size="sm" aria-label="Repository" className="min-w-0 gap-2">
                  <GithubIcon className="size-4 shrink-0 text-muted-foreground" />
                  <SelectValue placeholder="Repository" />
                </SelectTrigger>
                <SelectContent>
                  {repoOptions.map((r) => (
                    <SelectItem key={r.id} value={String(r.id)}>
                      {r.full_name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>

              {efforts.length > 0 && (
                <Select value={effort} onValueChange={setEffort}>
                  <SelectTrigger size="sm" aria-label="Effort" className="shrink-0 gap-2">
                    <GaugeIcon className="size-4 shrink-0 text-muted-foreground" />
                    <SelectValue placeholder="Effort" />
                  </SelectTrigger>
                  <SelectContent>
                    {efforts.map((ef) => (
                      <SelectItem key={ef} value={ef}>
                        {ef}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>
            <Button type="button" variant="ghost" size="sm" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" size="sm" disabled={!canSave}>
              {busy ? (
                <>
                  <CircleNotchIcon className="animate-spin" /> {automation ? 'Saving…' : 'Creating…'}
                </>
              ) : automation ? (
                'Save changes'
              ) : (
                'Create automation'
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
