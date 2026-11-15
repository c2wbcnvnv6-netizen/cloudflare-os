// The Google Doc preview client, run in a same-origin frame with a scripted session so its drawing
// can be read. ConnectionPreviewPane's test runs it in the real sandbox, where it cannot.

import { afterEach, expect, it } from 'vitest'
import DOCS_PREVIEW_CLIENT from '../../../../gatekeeper-google/src/docs-preview-client.txt?raw'

type Doc = { savedMarkdown: string, markdown?: string, styles?: object, tabs?: string[] }

let frame: HTMLIFrameElement | undefined

afterEach(() => frame?.remove())

/** Draws `doc` and resolves to the frame's document once the page has its blocks. */
async function draw(doc: Doc) {
  const gadget = {
    listTabs: async () => (doc.tabs ?? ['t.0']).map((id, index) =>
      ({ id, title: `Tab ${index + 1}`, index, nestingLevel: 0 })),
    getPendingChanges: async (tabId: string) => {
      if (!(doc.tabs ?? ['t.0']).includes(tabId)) throw new Error(`no tab with ID "${tabId}"`)
      // With several tabs, each reads as its own ID.
      const savedMarkdown = doc.tabs ? `${tabId}\n` : doc.savedMarkdown
      return { changes: [], markdown: savedMarkdown, ...doc, savedMarkdown }
    },
    getStyles: async () => doc.styles ?? Promise.reject(new Error('no styles')),
    listImages: async () => [],
  }
  Object.assign(window, { docsPreviewGadget: gadget })
  frame = document.body.appendChild(document.createElement('iframe'))
  frame.style.width = '900px'
  frame.srcdoc = `<body><script>window.gadget = parent.docsPreviewGadget</script>
    <script type="module">${DOCS_PREVIEW_CLIENT.replaceAll('</script', '<\\/script')}</script>`
  const page = () => frame!.contentDocument?.getElementById('page')
  await expect.poll(() => page() && !page()!.hasAttribute('aria-busy')).toBe(true)
  return {
    page: page()!,
    blocks: () => [...page()!.children] as HTMLElement[],
    look: (element: Element) => frame!.contentWindow!.getComputedStyle(element),
    async refresh(next: Partial<Doc>) {
      Object.assign(doc, next)
      frame!.contentWindow!.postMessage({ type: 'refresh' }, '*')
    },
  }
}

const BLUE = 'rgb(74, 134, 232)'
const STYLES = {
  page: { width: 600, marginTop: 72, marginRight: 72, marginLeft: 72 },
  named: {
    NORMAL_TEXT: { fontFamily: 'Arial', fontSize: 11 },
    TITLE: { fontFamily: 'Arial', fontSize: 26, color: '#4a86e8', alignment: 'center' },
    HEADING_1: { fontFamily: 'Arial', fontSize: 20, bold: true },
  },
  paragraphs: [
    { line: 0, style: 'TITLE' },
    { line: 2, style: 'NORMAL_TEXT', runs: [{ start: 6, end: 10, look: 0 }] },
  ],
  runLooks: [{ fontFamily: 'Consolas', color: '#880000' }],
  tables: [{
    line: 4,
    columns: [100, 300],
    rows: [[
      { background: '#d9ead3', look: { alignment: 'center' } },
      { borders: { top: { width: 0, color: '#000000' } } },
    ]],
  }],
}
const SAVED = [
  '# Report', '', 'plain code plain', '',
  '<table>', '  <tr>', '    <td><p>Head</p></td>', '    <td><p>Body</p></td>', '  </tr>', '</table>', '',
].join('\n')

it('draws paragraphs, runs and table cells in the styles the session gives', async () => {
  const { blocks, look } = await draw({ savedMarkdown: SAVED, styles: STYLES })
  const [title, paragraph, table] = blocks()

  // The title is a first-level heading in Markdown, told apart by its named style.
  expect(look(title).color).toBe(BLUE)
  expect(title.style.textAlign).toBe('center')
  expect(title.style.fontSize).toBe('26pt')

  const run = [...paragraph.querySelectorAll('span')].find(span => span.textContent === 'code')!
  expect(look(run).color).toBe('rgb(136, 0, 0)')
  expect(look(run).fontFamily).toContain('Consolas')
  expect(paragraph.textContent).toBe('plain code plain')

  const [head, body] = table.querySelectorAll('td')
  expect(look(head).backgroundColor).toBe('rgb(217, 234, 211)')
  expect(look(head).textAlign).toBe('center')
  expect(look(body).borderTopStyle).toBe('none')
  expect([...table.querySelectorAll('col')].map(column => column.style.width)).toEqual(['25%', '75%'])
})

it('keeps a run\'s look on the words an edit keeps, and gives an added block its kind\'s style', async () => {
  const { blocks, look, refresh } = await draw({ savedMarkdown: SAVED, styles: STYLES })

  await refresh({ markdown: SAVED.replace('plain code plain', 'plainer code plain\n\n# Added') })
  await expect.poll(() => blocks().some(block => block.classList.contains('changed'))).toBe(true)

  const changed = blocks().find(block => block.classList.contains('changed'))!
  expect(changed.querySelector('del')!.textContent).toBe('plain')
  expect(changed.querySelector('ins')!.textContent).toBe('plainer')
  const run = [...changed.querySelectorAll('span')].find(span => span.textContent === 'code')!
  expect(look(run).color).toBe('rgb(136, 0, 0)')

  // A new heading has no saved paragraph to take after, so it is a Heading 1, not the title.
  const added = blocks().find(block => block.classList.contains('added'))!
  expect(added.textContent).toBe('Added')
  expect(added.style.fontSize).toBe('20pt')
  expect(look(added).fontWeight).toBe('700')
  expect(added.style.textAlign).toBe('')
})

it('draws no paragraph\'s own look when a style is on a line that does not read as its kind', async () => {
  const styles = { ...STYLES, paragraphs: [{ line: 0, style: 'NORMAL_TEXT' }, STYLES.paragraphs[1]] }
  const { blocks } = await draw({ savedMarkdown: SAVED, styles })
  const [title, paragraph] = blocks()

  expect(title.style.fontSize).toBe('20pt')
  expect(paragraph.querySelectorAll('span')).toHaveLength(0)
})

it('draws the document in its own styles when the session gives none', async () => {
  const { blocks } = await draw({ savedMarkdown: SAVED })

  expect(blocks().map(block => block.tagName)).toEqual(['H1', 'P', 'DIV'])
  expect(blocks()[0].getAttribute('style')).toBeNull()
})

it('draws one empty paragraph for each the tab has, at its start and end as between blocks', async () => {
  // As the converter writes an empty paragraph first, between two paragraphs, and last.
  const { blocks } = await draw({ savedMarkdown: '\n\nFirst\n\n\n\nSecond\n\n\n' })

  expect(blocks().map(block => block.textContent)).toEqual(['', 'First', '', 'Second', ''])
})

it('draws a page break as the gap between two sheets', async () => {
  const { page } = await draw({ savedMarkdown: 'Before\n\n\\[Page break\\]\n\nAfter\n' })

  expect(page.querySelectorAll('.break')).toHaveLength(1)
  expect(page.textContent).toBe('BeforeAfter')
})

it('lists the tabs again on a refresh, and leaves a tab that has gone for the first', async () => {
  const { page, refresh } = await draw({ savedMarkdown: '', tabs: ['t.0', 'pending-tab-1'] })
  const buttons = () => [...frame!.contentDocument!.querySelectorAll<HTMLElement>('#tabs button')]
  buttons()[1].click()
  await expect.poll(() => page.textContent).toBe('pending-tab-1')

  // The tab's add was discarded.
  await refresh({ tabs: ['t.0'] })

  await expect.poll(() => page.textContent).toBe('t.0')
  expect(buttons()).toHaveLength(0)
  expect(frame!.contentDocument!.getElementById('error')).toBeNull()
})

it('lists the headings in an outline, marks a section that holds a change, and scrolls to one', async () => {
  const filler = Array.from({ length: 60 }, (_, line) => `Line ${line}`).join('\n\n')
  const savedMarkdown = `# Intro\n\n${filler}\n\n## Details\n\nOld text\n\n# Last\n\nEnd\n`
  const { page } = await draw({ savedMarkdown, markdown: savedMarkdown.replace('Old text', 'New text') })
  const outline = frame!.contentDocument!.getElementById('outline')!
  const entries = () => [...outline.querySelectorAll('button')]

  // The frame is too narrow for the outline to stand beside the page, so it starts closed.
  expect(outline.hidden).toBe(true)
  frame!.contentDocument!.getElementById('outline-toggle')!.click()

  expect(entries().map(entry => entry.textContent)).toEqual(['Intro', 'Details', 'Last'])
  expect(entries().map(entry => entry.classList.contains('touched'))).toEqual([false, true, false])
  expect(entries().map(entry => entry.style.paddingLeft)).toEqual(['8px', '20px', '8px'])

  entries()[1].click()
  const details = page.querySelector('h2')!
  await expect.poll(() => Math.round(details.getBoundingClientRect().top)).toBeLessThan(40)
  expect(outline.hidden).toBe(true)
})
