let users = 0
let style: HTMLStyleElement | undefined
const rules: string[] = []

export function registerMonacoStyle(css: string) {
  rules.push(css)
}

export function mountMonacoStyles() {
  if (++users === 1) {
    style = document.createElement('style')
    style.textContent = rules.join('\n')
    document.head.append(style)
  }
  return () => {
    if (--users === 0) {
      style?.remove()
      style = undefined
    }
  }
}
