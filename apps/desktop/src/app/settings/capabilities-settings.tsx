import { lazy, Suspense } from 'react'

import { PageLoader } from '@/components/page-loader'

import { type CapabilityPage, isCapabilityPage } from '../routes'

// The Capabilities surface (skills catalog, connectors, plugin inventory) is
// heavy; Settings only pays for it when this page opens.
const CapabilitiesView = lazy(async () => ({ default: (await import('../capabilities')).CapabilitiesView }))

/** Settings ▸ Capabilities: the former standalone page, its tabs driven by the
 *  Settings nav (`?tab=capabilities&page=<skills|plugins|connectors|toolsets>`). */
export function CapabilitiesSettings({
  onPageChange,
  subpage
}: {
  onPageChange: (page: CapabilityPage) => void
  subpage?: string
}) {
  const mode = isCapabilityPage(subpage) ? subpage : 'skills'

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-slot="settings-capabilities">
      <Suspense fallback={<PageLoader />}>
        <CapabilitiesView className="bg-transparent" hideTabs mode={mode} onModeChange={onPageChange} />
      </Suspense>
    </div>
  )
}
