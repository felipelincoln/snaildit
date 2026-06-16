import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { CheckCircleIcon, CircleIcon } from '@phosphor-icons/react'
import { AppPanel } from '@/components/setup/app-panel'
import { EnginePanel } from '@/components/setup/engine-panel'
import { ReposPanel } from '@/components/setup/repos-panel'
import { type DomainId, type State, getRepos } from '@/lib/api'

interface StepMeta {
  id: DomainId
  title: string
  description: string
}

const STEPS: StepMeta[] = [
  {
    id: 'app',
    title: 'Create your bot on GitHub',
    description:
      'Create a GitHub App you own — it can only do what you grant. Opens GitHub in a new tab and advances on its own once the App is created.',
  },
  {
    id: 'repos',
    title: 'Connect repositories',
    description:
      'Choose which repositories the App can act on. Opens GitHub in a new tab and advances on its own once installed.',
  },
  {
    id: 'engine',
    title: 'Give your bot a brain',
    description: 'Connect the AI engine that will run your automations.',
  },
]

function activeBody(id: DomainId, state: State, onAdvance: () => void): ReactNode {
  switch (id) {
    case 'app':
      return <AppPanel />
    case 'repos':
      return <ReposPanel appSlug={state.appSlug} />
    case 'engine':
      return <EnginePanel engine={state.engine} onAdvance={onAdvance} />
    default:
      return null
  }
}

function doneSummary(id: DomainId, state: State): ReactNode {
  switch (id) {
    case 'app':
      return state.appSlug ? <Summary>Connected as {state.appSlug}</Summary> : null
    case 'repos':
      return <ReposSummary />
    default:
      return null
  }
}

function Summary({ children }: { children: ReactNode }) {
  return <p className="mt-0.5 text-xs text-muted-foreground">{children}</p>
}

function ReposSummary() {
  const [count, setCount] = useState<number | null>(null)
  useEffect(() => {
    void getRepos()
      .then((r) => setCount(r.repos.length))
      .catch(() => {})
  }, [])
  if (count == null) return null
  return (
    <Summary>
      {count} {count === 1 ? 'repository' : 'repositories'} connected
    </Summary>
  )
}

export function SetupWizard({ state, onAdvance }: { state: State; onAdvance: () => void }) {
  return (
    <div className="mt-8 w-full max-w-lg">
      <h1 className="text-lg font-normal tracking-tight">Set up Snaild.it</h1>
      <p className="mb-6 text-sm text-muted-foreground">A few steps and your bot is live.</p>
      <ol>
        {STEPS.map((step, i) => {
          const active = state.step === step.id
          const done = state.domains[step.id].done
          return (
            <Step key={step.id} meta={step} done={done} active={active} last={i === STEPS.length - 1}>
              {active ? activeBody(step.id, state, onAdvance) : done ? doneSummary(step.id, state) : null}
            </Step>
          )
        })}
      </ol>
    </div>
  )
}

function Step({
  meta,
  done,
  active,
  last,
  children,
}: {
  meta: StepMeta
  done: boolean
  active: boolean
  last: boolean
  children?: ReactNode
}) {
  return (
    <li className="flex gap-3" aria-current={active ? 'step' : undefined}>
      <div className="flex flex-col items-center">
        <Indicator done={done} active={active} />
        {!last && <div className={`w-px flex-1 ${done ? 'bg-foreground' : 'bg-border'}`} />}
      </div>
      <div className="flex-1 pb-6">
        <h2 className={`text-sm font-normal ${active || done ? 'text-foreground' : 'text-muted-foreground'}`}>
          {meta.title}
        </h2>
        {active ? (
          <div className="mt-2 space-y-3">
            <p className="text-sm text-muted-foreground">{meta.description}</p>
            {children}
          </div>
        ) : (
          children
        )}
      </div>
    </li>
  )
}

function Indicator({ done, active }: { done: boolean; active: boolean }) {
  if (done) return <CheckCircleIcon weight="fill" className="size-5 text-foreground" />
  return (
    <CircleIcon
      weight={active ? 'fill' : 'regular'}
      className={`size-5 ${active ? 'text-primary' : 'text-muted-foreground/40'}`}
    />
  )
}
