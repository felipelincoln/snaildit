import { useEffect, useState } from 'react'
import { ArrowSquareOutIcon, CircleNotchIcon, PlusIcon } from '@phosphor-icons/react'
import { Dashboard } from '@/components/dashboard'
import { SetupWizard } from '@/components/setup-wizard'
import { Button } from '@/components/ui/button'
import { TooltipProvider } from '@/components/ui/tooltip'
import { type BotProfile, getBot } from '@/lib/api'
import { useSetupState } from '@/lib/use-setup-state'

export default function App() {
  const { state, refresh } = useSetupState()
  const [bot, setBot] = useState<BotProfile | null>(null)
  const [createNew, setCreateNew] = useState(0)

  useEffect(() => {
    if (!state?.appSlug) {
      setBot(null)
      return
    }
    let alive = true
    let timer: ReturnType<typeof setInterval> | undefined
    const load = () => {
      void getBot()
        .then((r) => {
          if (!alive) return
          setBot(r.bot)
          if (r.bot && timer) clearInterval(timer)
        })
        .catch(() => {})
    }
    load()
    timer = setInterval(load, 5000)
    return () => {
      alive = false
      if (timer) clearInterval(timer)
    }
  }, [state?.appSlug])

  useEffect(() => {
    document.title = bot?.name ?? 'Snaild.it'
    const href = bot ? `/api/avatar?v=${encodeURIComponent(bot.slug)}` : '/api/avatar'
    document.querySelectorAll('link[rel="icon"]').forEach((el) => {
      el.remove()
    })
    const link = document.createElement('link')
    link.rel = 'icon'
    link.href = href
    document.head.appendChild(link)
  }, [bot])

  return (
    <TooltipProvider delayDuration={300}>
      <div className="flex min-h-screen flex-col">
        <header className="border-b">
          <div className="mx-auto flex h-12 max-w-3xl items-center justify-between px-6">
            <BotIdentity bot={bot} />
            {state && (
              <Button size="sm" disabled={!state.onboarded} onClick={() => setCreateNew((c) => c + 1)}>
                <PlusIcon /> New automation
              </Button>
            )}
          </div>
        </header>
        <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col items-center px-6 pt-8 pb-24">
          {state == null ? (
            <CircleNotchIcon className="mt-24 size-5 animate-spin text-muted-foreground" />
          ) : state.onboarded ? (
            <Dashboard state={state} createNew={createNew} />
          ) : (
            <SetupWizard state={state} onAdvance={refresh} />
          )}
        </main>
      </div>
    </TooltipProvider>
  )
}

function BotIdentity({ bot }: { bot: BotProfile | null }) {
  if (!bot) return <span className="text-sm text-muted-foreground">No bot created yet</span>
  return (
    <a
      href={bot.url}
      target="_blank"
      rel="noreferrer"
      className="flex min-w-0 items-center gap-2 text-sm font-normal tracking-tight transition-opacity hover:opacity-80"
    >
      {bot.avatar ? (
        <img src={bot.avatar} alt="" className="size-7 shrink-0 rounded-md bg-white p-0.5" />
      ) : (
        <span className="size-7 shrink-0 rounded-md bg-muted" />
      )}
      <span className="truncate">{bot.name}</span>
      <ArrowSquareOutIcon className="size-3.5 shrink-0 text-muted-foreground" />
    </a>
  )
}
