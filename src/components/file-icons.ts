/**
 * File Icons Configuration
 * Maps file extensions and folder names to specific icons and colors
 * Inspired by VSCode's file icon theme
 */

import {
  BookOpen,
  Braces,
  Coffee,
  Cpu,
  Database,
  Diamond,
  File,
  // Languages & Frameworks
  FileCode,
  // Data & Config
  FileCog,
  // Media
  FileImage,
  FileJson,
  // Documents
  FileSpreadsheet,
  FileText,
  FileType,
  // Folders
  Folder,
  FolderOpen,
  // Web
  Globe,
  HardDrive,
  Hexagon,
  Image,
  Layout,
  Leaf,
  // Special
  Lock,
  type LucideIcon,
  Music,
  Package,
  Palette,
  PenTool,
  Server,
  Settings,
  Shield,
  Terminal,
  TestTube,
  Triangle,
  Video,
  Zap,
} from 'lucide-react';

/**
 * File icon configuration
 */
export interface FileIconConfig {
  icon: LucideIcon;
  color: string; // Tailwind color class
}

/**
 * Folder icon configuration
 */
export interface FolderIconConfig {
  icon: LucideIcon;
  openIcon?: LucideIcon;
  color: string;
}

/**
 * File extension to icon mapping
 * Priority: exact match > partial match > default
 */
const FILE_ICONS: Record<string, FileIconConfig> = {
  // JavaScript/TypeScript
  js: { icon: FileCode, color: 'text-yellow-500' },
  jsx: { icon: FileCode, color: 'text-blue-400' },
  ts: { icon: FileCode, color: 'text-blue-600' },
  tsx: { icon: FileCode, color: 'text-blue-500' },
  mjs: { icon: FileCode, color: 'text-yellow-500' },
  cjs: { icon: FileCode, color: 'text-yellow-600' },

  // Python
  py: { icon: FileCode, color: 'text-green-500' },
  pyx: { icon: FileCode, color: 'text-green-600' },
  pyi: { icon: FileCode, color: 'text-green-400' },
  ipynb: { icon: FileCode, color: 'text-orange-500' },

  // Java/JVM
  java: { icon: Coffee, color: 'text-red-500' },
  kt: { icon: FileCode, color: 'text-purple-500' },
  kts: { icon: FileCode, color: 'text-purple-400' },
  scala: { icon: FileCode, color: 'text-red-400' },
  groovy: { icon: FileCode, color: 'text-green-400' },
  gradle: { icon: FileCode, color: 'text-blue-400' },

  // C/C++
  c: { icon: FileCode, color: 'text-blue-400' },
  h: { icon: FileCode, color: 'text-purple-400' },
  cpp: { icon: FileCode, color: 'text-blue-500' },
  hpp: { icon: FileCode, color: 'text-purple-500' },
  cc: { icon: FileCode, color: 'text-blue-500' },
  cxx: { icon: FileCode, color: 'text-blue-500' },

  // C#
  cs: { icon: FileCode, color: 'text-green-500' },

  // Go
  go: { icon: FileCode, color: 'text-cyan-500' },

  // Rust
  rs: { icon: FileCode, color: 'text-orange-600' },

  // Ruby
  rb: { icon: Diamond, color: 'text-red-500' },
  erb: { icon: FileCode, color: 'text-red-400' },
  gemspec: { icon: Package, color: 'text-red-500' },

  // PHP
  php: { icon: FileCode, color: 'text-purple-500' },

  // Swift/Objective-C
  swift: { icon: FileCode, color: 'text-orange-500' },
  m: { icon: FileCode, color: 'text-blue-400' },
  mm: { icon: FileCode, color: 'text-blue-500' },

  // Web
  html: { icon: Globe, color: 'text-orange-500' },
  htm: { icon: Globe, color: 'text-orange-400' },
  css: { icon: Palette, color: 'text-blue-500' },
  scss: { icon: Palette, color: 'text-pink-500' },
  sass: { icon: Palette, color: 'text-pink-400' },
  less: { icon: Palette, color: 'text-purple-400' },
  vue: { icon: FileCode, color: 'text-green-500' },
  svelte: { icon: FileCode, color: 'text-orange-400' },
  astro: { icon: FileCode, color: 'text-purple-500' },

  // Data & Config
  json: { icon: FileJson, color: 'text-yellow-500' },
  jsonc: { icon: FileJson, color: 'text-yellow-600' },
  yaml: { icon: FileCog, color: 'text-purple-400' },
  yml: { icon: FileCog, color: 'text-purple-400' },
  toml: { icon: FileCog, color: 'text-purple-500' },
  xml: { icon: FileCode, color: 'text-orange-400' },
  ini: { icon: Settings, color: 'text-gray-500' },
  env: { icon: Lock, color: 'text-yellow-500' },
  properties: { icon: Settings, color: 'text-gray-500' },
  conf: { icon: Settings, color: 'text-gray-500' },
  config: { icon: Settings, color: 'text-gray-500' },

  // Database
  sql: { icon: Database, color: 'text-blue-400' },
  db: { icon: Database, color: 'text-gray-500' },
  sqlite: { icon: Database, color: 'text-blue-500' },
  prisma: { icon: Database, color: 'text-purple-500' },

  // Shell/Scripts
  sh: { icon: Terminal, color: 'text-green-500' },
  bash: { icon: Terminal, color: 'text-green-500' },
  zsh: { icon: Terminal, color: 'text-green-500' },
  fish: { icon: Terminal, color: 'text-green-400' },
  ps1: { icon: Terminal, color: 'text-blue-500' },
  bat: { icon: Terminal, color: 'text-gray-500' },
  cmd: { icon: Terminal, color: 'text-gray-500' },

  // Documentation
  md: { icon: BookOpen, color: 'text-blue-400' },
  mdx: { icon: BookOpen, color: 'text-blue-500' },
  rst: { icon: BookOpen, color: 'text-gray-500' },
  txt: { icon: FileText, color: 'text-gray-500' },
  rtf: { icon: FileText, color: 'text-gray-500' },
  pdf: { icon: FileText, color: 'text-red-500' },
  doc: { icon: FileText, color: 'text-blue-500' },
  docx: { icon: FileText, color: 'text-blue-500' },

  // Spreadsheet
  csv: { icon: FileSpreadsheet, color: 'text-green-500' },
  xls: { icon: FileSpreadsheet, color: 'text-green-500' },
  xlsx: { icon: FileSpreadsheet, color: 'text-green-500' },

  // Images
  png: { icon: FileImage, color: 'text-purple-400' },
  jpg: { icon: FileImage, color: 'text-purple-400' },
  jpeg: { icon: FileImage, color: 'text-purple-400' },
  gif: { icon: FileImage, color: 'text-purple-500' },
  svg: { icon: Image, color: 'text-yellow-500' },
  ico: { icon: FileImage, color: 'text-yellow-400' },
  webp: { icon: FileImage, color: 'text-purple-400' },
  bmp: { icon: FileImage, color: 'text-purple-400' },

  // Audio
  mp3: { icon: Music, color: 'text-green-500' },
  wav: { icon: Music, color: 'text-green-500' },
  flac: { icon: Music, color: 'text-green-500' },
  aac: { icon: Music, color: 'text-green-500' },
  ogg: { icon: Music, color: 'text-green-500' },
  m4a: { icon: Music, color: 'text-green-500' },

  // Video
  mp4: { icon: Video, color: 'text-red-500' },
  avi: { icon: Video, color: 'text-red-500' },
  mkv: { icon: Video, color: 'text-red-500' },
  mov: { icon: Video, color: 'text-red-500' },
  wmv: { icon: Video, color: 'text-red-500' },
  webm: { icon: Video, color: 'text-red-500' },

  // Archive
  zip: { icon: Package, color: 'text-yellow-500' },
  tar: { icon: Package, color: 'text-yellow-500' },
  gz: { icon: Package, color: 'text-yellow-500' },
  rar: { icon: Package, color: 'text-yellow-500' },
  '7z': { icon: Package, color: 'text-yellow-500' },
  bz2: { icon: Package, color: 'text-yellow-500' },

  // Build & Package
  dockerfile: { icon: HardDrive, color: 'text-blue-500' },
  makefile: { icon: FileCode, color: 'text-gray-500' },
  cmake: { icon: FileCode, color: 'text-green-500' },

  // Lock files
  lock: { icon: Lock, color: 'text-gray-500' },

  // Test files
  spec: { icon: TestTube, color: 'text-green-500' },
  test: { icon: TestTube, color: 'text-green-500' },

  // GraphQL
  graphql: { icon: Hexagon, color: 'text-pink-500' },
  gql: { icon: Hexagon, color: 'text-pink-500' },

  // Markdown
  markdown: { icon: BookOpen, color: 'text-blue-400' },

  // Styles
  styl: { icon: Palette, color: 'text-green-500' },

  // Misc
  log: { icon: FileText, color: 'text-gray-500' },
  map: { icon: FileCode, color: 'text-gray-500' },
  gitignore: { icon: FileCode, color: 'text-gray-500' },
  gitattributes: { icon: FileCode, color: 'text-gray-500' },
  editorconfig: { icon: Settings, color: 'text-gray-500' },
  prettierignore: { icon: Settings, color: 'text-gray-500' },
  eslintrc: { icon: Shield, color: 'text-purple-500' },
  eslintignore: { icon: Shield, color: 'text-purple-500' },
  biome: { icon: Settings, color: 'text-green-500' },
};

/**
 * Special file names (exact match)
 */
const SPECIAL_FILE_ICONS: Record<string, FileIconConfig> = {
  // Package managers
  'package.json': { icon: Package, color: 'text-red-500' },
  'package-lock.json': { icon: Lock, color: 'text-red-400' },
  'yarn.lock': { icon: Lock, color: 'text-blue-400' },
  'pnpm-lock.yaml': { icon: Lock, color: 'text-orange-400' },
  'bun.lockb': { icon: Lock, color: 'text-gray-400' },

  // Config files
  'tsconfig.json': { icon: FileCode, color: 'text-blue-600' },
  'jsconfig.json': { icon: FileCode, color: 'text-yellow-500' },
  '.env': { icon: Lock, color: 'text-yellow-500' },
  '.env.local': { icon: Lock, color: 'text-yellow-500' },
  '.env.development': { icon: Lock, color: 'text-yellow-500' },
  '.env.production': { icon: Lock, color: 'text-yellow-500' },
  '.env.test': { icon: Lock, color: 'text-yellow-500' },

  // Docker
  Dockerfile: { icon: HardDrive, color: 'text-blue-500' },
  'docker-compose.yml': { icon: HardDrive, color: 'text-blue-500' },
  'docker-compose.yaml': { icon: HardDrive, color: 'text-blue-500' },
  '.dockerignore': { icon: FileCode, color: 'text-gray-500' },

  // CI/CD
  '.travis.yml': { icon: Zap, color: 'text-yellow-500' },
  '.gitlab-ci.yml': { icon: Zap, color: 'text-orange-500' },
  Jenkinsfile: { icon: Server, color: 'text-red-500' },

  // Git
  '.gitignore': { icon: FileCode, color: 'text-gray-500' },
  '.gitattributes': { icon: FileCode, color: 'text-gray-500' },
  '.gitmodules': { icon: FileCode, color: 'text-gray-500' },
  '.gitkeep': { icon: FileCode, color: 'text-gray-500' },

  // Linting/Formatting
  '.eslintrc': { icon: Shield, color: 'text-purple-500' },
  '.eslintrc.js': { icon: Shield, color: 'text-purple-500' },
  '.eslintrc.json': { icon: Shield, color: 'text-purple-500' },
  '.eslintrc.yml': { icon: Shield, color: 'text-purple-500' },
  '.prettierrc': { icon: Palette, color: 'text-purple-500' },
  '.prettierrc.js': { icon: Palette, color: 'text-purple-500' },
  '.prettierrc.json': { icon: Palette, color: 'text-purple-500' },
  '.prettierrc.yml': { icon: Palette, color: 'text-purple-500' },
  'biome.json': { icon: Settings, color: 'text-green-500' },

  // Editor
  '.editorconfig': { icon: Settings, color: 'text-gray-500' },
  '.vscode': { icon: Settings, color: 'text-blue-500' },

  // License
  LICENSE: { icon: FileText, color: 'text-gray-500' },
  'LICENSE.md': { icon: FileText, color: 'text-gray-500' },
  'LICENSE.txt': { icon: FileText, color: 'text-gray-500' },
  COPYING: { icon: FileText, color: 'text-gray-500' },

  // Readme
  README: { icon: BookOpen, color: 'text-blue-400' },
  'README.md': { icon: BookOpen, color: 'text-blue-400' },
  'README.txt': { icon: BookOpen, color: 'text-blue-400' },
  CHANGELOG: { icon: BookOpen, color: 'text-gray-500' },
  'CHANGELOG.md': { icon: BookOpen, color: 'text-gray-500' },
  CONTRIBUTING: { icon: BookOpen, color: 'text-gray-500' },
  'CONTRIBUTING.md': { icon: BookOpen, color: 'text-gray-500' },

  // Make
  Makefile: { icon: FileCode, color: 'text-gray-500' },
  'CMakeLists.txt': { icon: FileCode, color: 'text-green-500' },

  // Rust
  'Cargo.toml': { icon: Package, color: 'text-orange-600' },
  'Cargo.lock': { icon: Lock, color: 'text-orange-500' },

  // Go
  'go.mod': { icon: FileCode, color: 'text-cyan-500' },
  'go.sum': { icon: Lock, color: 'text-cyan-400' },

  // Python
  'requirements.txt': { icon: FileText, color: 'text-green-500' },
  'setup.py': { icon: FileCode, color: 'text-green-500' },
  'pyproject.toml': { icon: FileCog, color: 'text-green-500' },
  Pipfile: { icon: FileText, color: 'text-green-500' },
  'Pipfile.lock': { icon: Lock, color: 'text-green-400' },

  // Ruby
  Gemfile: { icon: Diamond, color: 'text-red-500' },
  'Gemfile.lock': { icon: Lock, color: 'text-red-400' },
  Rakefile: { icon: FileCode, color: 'text-red-500' },

  // PHP
  'composer.json': { icon: Package, color: 'text-purple-500' },
  'composer.lock': { icon: Lock, color: 'text-purple-400' },

  // Java
  'pom.xml': { icon: FileCode, color: 'text-red-500' },
  'build.gradle': { icon: FileCode, color: 'text-blue-400' },
  'settings.gradle': { icon: Settings, color: 'text-blue-400' },

  // Misc
  '.nvmrc': { icon: Settings, color: 'text-green-500' },
  '.node-version': { icon: Settings, color: 'text-green-500' },
  '.python-version': { icon: Settings, color: 'text-green-500' },
  Vagrantfile: { icon: Server, color: 'text-blue-500' },
  Procfile: { icon: FileText, color: 'text-purple-500' },
};

/**
 * Folder name to icon mapping
 */
const FOLDER_ICONS: Record<string, FolderIconConfig> = {
  // Source code
  src: { icon: Folder, color: 'text-blue-500' },
  source: { icon: Folder, color: 'text-blue-500' },
  sources: { icon: Folder, color: 'text-blue-500' },
  lib: { icon: Folder, color: 'text-blue-400' },
  library: { icon: Folder, color: 'text-blue-400' },
  app: { icon: Folder, color: 'text-blue-500' },
  apps: { icon: Folder, color: 'text-blue-500' },

  // Components
  components: { icon: Folder, color: 'text-purple-500' },
  component: { icon: Folder, color: 'text-purple-500' },

  // Config
  config: { icon: Folder, color: 'text-gray-500' },
  configs: { icon: Folder, color: 'text-gray-500' },
  configuration: { icon: Folder, color: 'text-gray-500' },
  settings: { icon: Folder, color: 'text-gray-500' },

  // Git
  '.git': { icon: Folder, color: 'text-orange-500' },
  git: { icon: Folder, color: 'text-orange-500' },
  '.github': { icon: Folder, color: 'text-gray-500' },
  github: { icon: Folder, color: 'text-gray-500' },
  worktrees: { icon: Folder, color: 'text-orange-400' },

  // Build
  build: { icon: Folder, color: 'text-yellow-500' },
  builds: { icon: Folder, color: 'text-yellow-500' },
  dist: { icon: Folder, color: 'text-yellow-500' },
  out: { icon: Folder, color: 'text-yellow-500' },
  output: { icon: Folder, color: 'text-yellow-500' },
  target: { icon: Folder, color: 'text-yellow-500' },
  bin: { icon: Folder, color: 'text-yellow-500' },
  binary: { icon: Folder, color: 'text-yellow-500' },

  // Dependencies
  node_modules: { icon: Folder, color: 'text-green-500' },
  vendor: { icon: Folder, color: 'text-gray-500' },
  packages: { icon: Folder, color: 'text-green-500' },
  package: { icon: Folder, color: 'text-green-500' },

  // Tests
  test: { icon: Folder, color: 'text-green-500' },
  tests: { icon: Folder, color: 'text-green-500' },
  testing: { icon: Folder, color: 'text-green-500' },
  spec: { icon: Folder, color: 'text-green-500' },
  specs: { icon: Folder, color: 'text-green-500' },
  __tests__: { icon: Folder, color: 'text-green-500' },
  __mocks__: { icon: Folder, color: 'text-yellow-500' },

  // Assets
  assets: { icon: Folder, color: 'text-purple-500' },
  static: { icon: Folder, color: 'text-gray-500' },
  public: { icon: Folder, color: 'text-gray-500' },
  resources: { icon: Folder, color: 'text-purple-500' },
  res: { icon: Folder, color: 'text-purple-500' },

  // Media
  images: { icon: Folder, color: 'text-purple-500' },
  img: { icon: Folder, color: 'text-purple-500' },
  icons: { icon: Folder, color: 'text-purple-500' },
  icon: { icon: Folder, color: 'text-purple-500' },
  pictures: { icon: Folder, color: 'text-purple-500' },
  photos: { icon: Folder, color: 'text-purple-500' },
  media: { icon: Folder, color: 'text-purple-500' },
  audio: { icon: Folder, color: 'text-green-500' },
  sound: { icon: Folder, color: 'text-green-500' },
  sounds: { icon: Folder, color: 'text-green-500' },
  video: { icon: Folder, color: 'text-red-500' },
  videos: { icon: Folder, color: 'text-red-500' },

  // Styles
  styles: { icon: Folder, color: 'text-pink-500' },
  style: { icon: Folder, color: 'text-pink-500' },
  css: { icon: Folder, color: 'text-pink-500' },
  scss: { icon: Folder, color: 'text-pink-500' },
  sass: { icon: Folder, color: 'text-pink-500' },
  less: { icon: Folder, color: 'text-pink-500' },

  // Documentation
  docs: { icon: Folder, color: 'text-blue-400' },
  doc: { icon: Folder, color: 'text-blue-400' },
  documentation: { icon: Folder, color: 'text-blue-400' },

  // Scripts
  scripts: { icon: Folder, color: 'text-green-500' },
  script: { icon: Folder, color: 'text-green-500' },

  // Database
  database: { icon: Folder, color: 'text-blue-500' },
  db: { icon: Folder, color: 'text-blue-500' },
  migrations: { icon: Folder, color: 'text-blue-400' },
  migration: { icon: Folder, color: 'text-blue-400' },
  seeds: { icon: Folder, color: 'text-green-500' },
  seed: { icon: Folder, color: 'text-green-500' },

  // Security
  security: { icon: Folder, color: 'text-yellow-500' },
  secure: { icon: Folder, color: 'text-yellow-500' },
  auth: { icon: Folder, color: 'text-yellow-500' },
  authentication: { icon: Folder, color: 'text-yellow-500' },

  // Server
  server: { icon: Folder, color: 'text-blue-500' },
  servers: { icon: Folder, color: 'text-blue-500' },
  api: { icon: Folder, color: 'text-green-500' },
  apis: { icon: Folder, color: 'text-green-500' },
  backend: { icon: Folder, color: 'text-blue-500' },

  // Client
  client: { icon: Folder, color: 'text-blue-500' },
  frontend: { icon: Folder, color: 'text-blue-500' },
  web: { icon: Folder, color: 'text-blue-500' },

  // Utils
  utils: { icon: Folder, color: 'text-gray-500' },
  util: { icon: Folder, color: 'text-gray-500' },
  utilities: { icon: Folder, color: 'text-gray-500' },
  tools: { icon: Folder, color: 'text-gray-500' },
  tool: { icon: Folder, color: 'text-gray-500' },
  helpers: { icon: Folder, color: 'text-gray-500' },
  helper: { icon: Folder, color: 'text-gray-500' },

  // Hooks (React)
  hooks: { icon: Folder, color: 'text-yellow-500' },
  hook: { icon: Folder, color: 'text-yellow-500' },

  // Types
  types: { icon: Folder, color: 'text-blue-500' },
  type: { icon: Folder, color: 'text-blue-500' },
  typings: { icon: Folder, color: 'text-blue-500' },
  '@types': { icon: Folder, color: 'text-blue-500' },

  // Models
  models: { icon: Folder, color: 'text-purple-500' },
  model: { icon: Folder, color: 'text-purple-500' },

  // Views
  views: { icon: Folder, color: 'text-purple-500' },
  view: { icon: Folder, color: 'text-purple-500' },
  pages: { icon: Folder, color: 'text-purple-500' },
  page: { icon: Folder, color: 'text-purple-500' },
  screens: { icon: Folder, color: 'text-purple-500' },
  screen: { icon: Folder, color: 'text-purple-500' },

  // Layouts
  layouts: { icon: Folder, color: 'text-purple-500' },
  layout: { icon: Folder, color: 'text-purple-500' },

  // Services
  services: { icon: Folder, color: 'text-green-500' },
  service: { icon: Folder, color: 'text-green-500' },

  // Stores
  stores: { icon: Folder, color: 'text-purple-500' },
  store: { icon: Folder, color: 'text-purple-500' },
  state: { icon: Folder, color: 'text-purple-500' },

  // Context
  context: { icon: Folder, color: 'text-blue-500' },
  contexts: { icon: Folder, color: 'text-blue-500' },

  // Constants
  constants: { icon: Folder, color: 'text-gray-500' },
  constant: { icon: Folder, color: 'text-gray-500' },
  const: { icon: Folder, color: 'text-gray-500' },

  // Core
  core: { icon: Folder, color: 'text-blue-500' },

  // Common
  common: { icon: Folder, color: 'text-gray-500' },
  shared: { icon: Folder, color: 'text-gray-500' },

  // Examples
  examples: { icon: Folder, color: 'text-green-500' },
  example: { icon: Folder, color: 'text-green-500' },
  demo: { icon: Folder, color: 'text-green-500' },
  demos: { icon: Folder, color: 'text-green-500' },

  // Logs
  logs: { icon: Folder, color: 'text-gray-500' },
  log: { icon: Folder, color: 'text-gray-500' },

  // Cache
  cache: { icon: Folder, color: 'text-gray-500' },
  '.cache': { icon: Folder, color: 'text-gray-500' },

  // Temp
  temp: { icon: Folder, color: 'text-gray-500' },
  tmp: { icon: Folder, color: 'text-gray-500' },
  '.tmp': { icon: Folder, color: 'text-gray-500' },

  // Environment
  env: { icon: Folder, color: 'text-yellow-500' },
  environments: { icon: Folder, color: 'text-yellow-500' },
  environment: { icon: Folder, color: 'text-yellow-500' },

  // Features
  features: { icon: Folder, color: 'text-yellow-500' },
  feature: { icon: Folder, color: 'text-yellow-500' },
  modules: { icon: Folder, color: 'text-blue-500' },
  module: { icon: Folder, color: 'text-blue-500' },

  // Plugins
  plugins: { icon: Folder, color: 'text-purple-500' },
  plugin: { icon: Folder, color: 'text-purple-500' },

  // Middleware
  middleware: { icon: Folder, color: 'text-gray-500' },
  middlewares: { icon: Folder, color: 'text-gray-500' },

  // Interfaces
  interfaces: { icon: Folder, color: 'text-blue-500' },
  interface: { icon: Folder, color: 'text-blue-500' },

  // Locales
  locales: { icon: Folder, color: 'text-blue-500' },
  locale: { icon: Folder, color: 'text-blue-500' },
  lang: { icon: Folder, color: 'text-blue-500' },
  languages: { icon: Folder, color: 'text-blue-500' },
  i18n: { icon: Folder, color: 'text-blue-500' },

  // Design
  design: { icon: Folder, color: 'text-pink-500' },
  designs: { icon: Folder, color: 'text-pink-500' },

  // Content
  content: { icon: Folder, color: 'text-gray-500' },
  contents: { icon: Folder, color: 'text-gray-500' },

  // Data
  data: { icon: Folder, color: 'text-purple-500' },

  // Config dotfiles
  '.vscode': { icon: Folder, color: 'text-blue-500' },
  '.idea': { icon: Folder, color: 'text-purple-500' },
  '.vscode-test': { icon: Folder, color: 'text-blue-400' },
};

/**
 * Get file icon by filename
 */
export function getFileIcon(filename: string): FileIconConfig {
  // Check special files first (exact match)
  if (SPECIAL_FILE_ICONS[filename]) {
    return SPECIAL_FILE_ICONS[filename];
  }

  // Get file extension
  const lastDot = filename.lastIndexOf('.');
  if (lastDot > 0 && lastDot < filename.length - 1) {
    // Check for compound extensions (e.g., .spec.ts, .test.js)
    const secondLastDot = filename.lastIndexOf('.', lastDot - 1);
    if (secondLastDot > 0) {
      const middlePart = filename.slice(secondLastDot + 1, lastDot).toLowerCase();
      // Check if middle part is test or spec
      if (middlePart === 'test' || middlePart === 'spec') {
        return { icon: TestTube, color: 'text-green-500' };
      }

      // Check compound extension in FILE_ICONS
      const compoundExt = filename.slice(secondLastDot + 1).toLowerCase();
      if (FILE_ICONS[compoundExt]) {
        return FILE_ICONS[compoundExt];
      }
    }

    // Check exact extension match
    const ext = filename.slice(lastDot + 1).toLowerCase();
    if (FILE_ICONS[ext]) {
      return FILE_ICONS[ext];
    }
  }

  // Default icon
  return { icon: File, color: 'text-gray-500' };
}

/**
 * Get folder icon by folder name
 */
export function getFolderIcon(folderName: string, isOpen: boolean): FolderIconConfig {
  const config = FOLDER_ICONS[folderName.toLowerCase()];

  if (config) {
    return {
      ...config,
      icon: isOpen && config.openIcon ? config.openIcon : config.icon,
    };
  }

  // Default folder icon
  return {
    icon: isOpen ? FolderOpen : Folder,
    color: 'text-yellow-500',
  };
}
