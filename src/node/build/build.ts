import { getIconsCSS } from '@iconify/utils'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import pMap from 'p-map'
import { packageDirectorySync } from 'package-directory'
import type { BuildOptions, Rolldown } from 'vite'
import { resolveConfig, type SiteConfig } from '../config'
import { clearCache } from '../markdownToVue'
import { slash, type Awaitable, type HeadConfig } from '../shared'
import { deserializeFunctions, serializeFunctions } from '../utils/fnSerialize'
import { nativeImport } from '../utils/nativeImport'
import { task } from '../utils/task'
import { bundle } from './bundle'
import { generateSitemap } from './generateSitemap'
import { renderPage } from './render'

const require = createRequire(import.meta.url)

export async function build(
  root?: string,
  buildOptions: BuildOptions & {
    base?: string
    mpa?: string
    onAfterConfigResolve?: (siteConfig: SiteConfig) => Awaitable<void>
  } = {}
) {
  const start = Date.now()

  process.env.NODE_ENV = 'production'
  const siteConfig = await resolveConfig(root, 'build', 'production')

  await buildOptions.onAfterConfigResolve?.(siteConfig)
  delete buildOptions.onAfterConfigResolve

  const unlinkVue = linkVue()

  if (buildOptions.base) {
    siteConfig.site.base = buildOptions.base
    delete buildOptions.base
  }

  if (buildOptions.mpa) {
    siteConfig.mpa = true
    delete buildOptions.mpa
  }

  if (buildOptions.outDir) {
    siteConfig.outDir = path.resolve(process.cwd(), buildOptions.outDir)
    delete buildOptions.outDir
  }

  try {
    const { clientResult, serverResult, pageToHashMap } = await bundle(
      siteConfig,
      buildOptions
    )

    if (process.env.BUNDLE_ONLY) {
      return
    }

    const entryPath = path.join(siteConfig.tempDir, 'app.js')
    const { render } = await nativeImport(entryPath)

    await task('rendering pages', async () => {
      const clientOutput: (Rolldown.OutputChunk | Rolldown.OutputAsset)[] =
        clientResult?.output || []

      const appChunk = clientOutput.find(
        (chunk): chunk is Rolldown.OutputChunk =>
          chunk.type === 'chunk' &&
          chunk.isEntry &&
          !!chunk.facadeModuleId?.endsWith('.js')
      )

      const isDefaultTheme = clientOutput.some(
        (chunk): chunk is Rolldown.OutputChunk =>
          chunk.type === 'chunk' &&
          chunk.name === 'theme' &&
          chunk.moduleIds.some((id) => id.includes('client/theme-default'))
      )

      // ----

      const resultOutput: (Rolldown.OutputChunk | Rolldown.OutputAsset)[] =
        (siteConfig.mpa ? serverResult : clientResult)?.output || []

      const cssChunk = resultOutput.find(
        (chunk): chunk is Rolldown.OutputAsset =>
          chunk.type === 'asset' && chunk.fileName.endsWith('.css')
      )

      // prettier-ignore
      const assets = resultOutput.filter(
        (chunk): chunk is Rolldown.OutputAsset =>
          chunk.type === 'asset' && !chunk.fileName.endsWith('.css')
      ).map((asset) => siteConfig.site.base + asset.fileName)

      // ----

      const additionalHeadTags: HeadConfig[] = []
      const metadataScript = generateMetadataScript(pageToHashMap, siteConfig)

      if (isDefaultTheme) {
        const fontURL = assets.find((file) =>
          /inter-roman-latin\.[\w-]+\.woff2/.test(file)
        )
        if (fontURL) {
          additionalHeadTags.push([
            'link',
            {
              rel: 'preload',
              href: fontURL,
              as: 'font',
              type: 'font/woff2',
              crossorigin: ''
            }
          ])
        }
      }

      const usedIcons = new Set<string>()

      await pMap(
        ['404.md', ...siteConfig.pages],
        async (page) => {
          await renderPage(
            render,
            siteConfig,
            siteConfig.rewrites.map[page] || page,
            clientResult,
            appChunk,
            cssChunk,
            assets,
            pageToHashMap,
            metadataScript,
            additionalHeadTags,
            usedIcons
          )
        },
        { concurrency: siteConfig.buildConcurrency }
      )

      const icons = require('@iconify-json/simple-icons/icons.json')
      const iconsCss = getIconsCSS(icons, Array.from(usedIcons).sort(), {
        iconSelector: '.vpi-social-{name}',
        commonSelector: '.vpi-social',
        varName: 'icon',
        format: process.env.DEBUG ? 'expanded' : 'compressed',
        mode: 'mask'
      }).replace(/[^]*?}\n*/, '')

      fs.writeFileSync(path.join(siteConfig.outDir, 'vp-icons.css'), iconsCss)
    })

    // emit page hash map for the case where a user session is open
    // when the site got redeployed (which invalidates current hash map)
    fs.writeFileSync(
      path.join(siteConfig.outDir, 'hashmap.json'),
      JSON.stringify(pageToHashMap)
    )
  } finally {
    unlinkVue()
    if (!process.env.DEBUG) {
      fs.rmSync(siteConfig.tempDir, {
        recursive: true,
        force: true,
        maxRetries: 10
      })
    }
  }

  await generateSitemap(siteConfig)
  await siteConfig.buildEnd?.(siteConfig)
  clearCache()

  siteConfig.logger.info(
    `build complete in ${((Date.now() - start) / 1000).toFixed(2)}s.`
  )
}

function linkVue() {
  const root = packageDirectorySync()
  if (root) {
    const dest = path.resolve(root, 'node_modules/vue')
    // if user did not install vue by themselves, link VitePress' version
    if (!fs.existsSync(dest)) {
      const src = path.dirname(createRequire(import.meta.url).resolve('vue'))
      fs.mkdirSync(path.dirname(dest), { recursive: true })
      fs.symlinkSync(src, dest, 'junction')
      return () => {
        fs.unlinkSync(dest)
      }
    }
  }
  return () => {}
}

function generateMetadataScript(
  pageToHashMap: Record<string, string>,
  config: SiteConfig
) {
  if (config.mpa) {
    return { html: '', inHead: false }
  }

  const hashMapString = JSON.stringify(JSON.stringify(pageToHashMap))

  // ── PATCHED: __VP_HASH_MAP__ + __VP_SITE_DATA__ 合并到独立 JS、浏览器跨页面缓存 ──
  const _sdJson = JSON.stringify(
    serializeFunctions({ ...config.site, head: [] })
  )
  const _sdData =
    `window.__VP_HASH_MAP__=JSON.parse(${hashMapString});` +
    (_sdJson.includes('_vp-fn_')
      ? `${deserializeFunctions};window.__VP_SITE_DATA__=deserializeFunctions(JSON.parse('${_sdJson}'));`
      : `window.__VP_SITE_DATA__=JSON.parse('${_sdJson}');`)
  const _sdHash = createHash('sha256').update(_sdData).digest('hex').slice(0, 8)
  const _sdFile = path.join(config.assetsDir, `site-data.${_sdHash}.js`)
  fs.mkdirSync(path.dirname(path.join(config.outDir, _sdFile)), {
    recursive: true
  })
  fs.writeFileSync(path.join(config.outDir, _sdFile), _sdData)
  const _sdURL = slash(config.site.base + _sdFile)

  // ── PATCHED: sitemap 完全从 sidebar 配置生成（路径 + 标题）──
  const _smUrls: string[] = []
  const _seen = new Set<string>()
  function addUrl(u: string, text: string) {
    if (!_seen.has(u)) {
      _seen.add(u)
      _smUrls.push(`${u} - ${text}`)
    }
  }
  function collectSidebar(items: any[], base: string) {
    for (const item of items) {
      // 嵌套 section：用 item 自身的 base（完整路径）递归
      const itemBase = item.base || base
      if (item.link && item.text) {
        const link = (item.link as string).startsWith('/')
          ? itemBase + item.link
          : itemBase + '/' + item.link
        addUrl(link.replace(/\/$/, '') || '/', item.text)
      }
      if (item.items) collectSidebar(item.items, itemBase)
    }
  }
  const sidebar: any[] = (config.site.themeConfig as any).sidebar || []
  for (const section of sidebar) {
    const base = (section.base || '') as string
    if (section.link && section.text) {
      addUrl((base + section.link).replace(/\/$/, '') || '/', section.text)
    }
    if (section.items) collectSidebar(section.items, base)
  }
  // 兜底：pageToHashMap 中有但 sidebar 中没有的页面
  for (const k of Object.keys(pageToHashMap)) {
    if (k === '404') continue
    const u =
      '/' +
      k
        .replace(/_/g, '/')
        .replace(/\.md$/, '')
        .replace(/\/index$/, '')
    if (!_seen.has(u) && !_seen.has(u + '/')) {
      _smUrls.push(u)
    }
  }
  _smUrls.sort()
  const _sitemap = `\n<nav id="sitemap" aria-hidden="true">\n${_smUrls.join('\n')}\n</nav><style>#sitemap { display: none; }</style>`

  if (!config.metaChunk) {
    return {
      html: `<script src="${_sdURL}"></script>${_sitemap}`,
      inHead: true
    }
  }

  return {
    html: `<script src="${_sdURL}"></script>${_sitemap}`,
    inHead: true
  }
}
