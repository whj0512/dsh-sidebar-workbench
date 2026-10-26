/** CSS Modules and compiled stylesheet inputs consumed by the local bundler. */
declare module '*.module.css' {
  const classes: Readonly<Record<string, string>>
  export default classes
}

declare module '*.module.css?inline' {
  const stylesheet: string
  export default stylesheet
}
