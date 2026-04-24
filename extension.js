const fs = require("node:fs")
const path = require("node:path")
const YAML = require("yaml")

let vscodeApi
let diagnosticCollection
let outputChannel
let statusBarItem
let treeDataProvider
let latestAnalysis = null

function getVscode() {
  if (!vscodeApi) {
    vscodeApi = require("vscode")
  }
  return vscodeApi
}

function stripJsonComments(value) {
  return value
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
}

function readText(filePath) {
  try {
    return fs.readFileSync(filePath, "utf8")
  } catch {
    return null
  }
}

function writeText(filePath, contents) {
  fs.writeFileSync(filePath, contents, "utf8")
}

function parseJsonFile(filePath) {
  const raw = readText(filePath)
  if (!raw) {
    return null
  }

  try {
    return JSON.parse(stripJsonComments(raw))
  } catch {
    return null
  }
}

function parseYamlFile(filePath) {
  const raw = readText(filePath)
  if (!raw) {
    return null
  }

  try {
    return YAML.parse(raw)
  } catch {
    return null
  }
}

function findWorkspaceFolder() {
  const vscode = getVscode()
  const [folder] = vscode.workspace.workspaceFolders || []
  return folder
}

function normalizeVersion(value) {
  if (value === undefined || value === null) {
    return null
  }

  const normalized = String(value).trim()
  if (!normalized) {
    return null
  }

  return normalized.replace(/^[=v]+/, "")
}

function firstLine(text) {
  return text.split(/\r?\n/)[0].trim()
}

function toRelativeFilePath(rootPath, filePath) {
  return path.relative(rootPath, filePath).replace(/\\/g, "/")
}

function makeSignal({
  rootPath,
  ecosystem,
  key,
  source,
  filePath,
  value,
  detail,
  fixable = false,
}) {
  return {
    ecosystem,
    key,
    source,
    filePath,
    relativePath: toRelativeFilePath(rootPath, filePath),
    value: value ? String(value) : null,
    detail: detail || null,
    fixable,
  }
}

function makeIssue({ ecosystem, severity, code, message, signals = [], suggestedValue = null }) {
  return {
    ecosystem,
    severity,
    code,
    message,
    signals,
    suggestedValue,
  }
}

function extractDevcontainerRuntimeVersion(devcontainer, runtime) {
  const features = devcontainer.features || {}

  for (const [featureName, config] of Object.entries(features)) {
    if (!featureName.includes(`/${runtime}`)) {
      continue
    }

    if (typeof config === "string") {
      return config
    }

    if (config && typeof config === "object" && config.version) {
      return String(config.version)
    }
  }

  if (typeof devcontainer.image === "string") {
    const match = devcontainer.image.match(new RegExp(`${runtime}:(?<version>[\\w.-]+)`))
    if (match && match.groups && match.groups.version) {
      return match.groups.version
    }
  }

  return null
}

function globbedFiles(rootPath, subPath, matcher) {
  const directoryPath = path.join(rootPath, subPath)
  if (!fs.existsSync(directoryPath)) {
    return []
  }

  return fs
    .readdirSync(directoryPath, { withFileTypes: true })
    .filter((entry) => entry.isFile() && matcher(entry.name))
    .map((entry) => path.join(directoryPath, entry.name))
}

function readGithubActionsSignals(rootPath) {
  const files = globbedFiles(rootPath, path.join(".github", "workflows"), (name) => /\.ya?ml$/i.test(name))
  const signals = []

  for (const filePath of files) {
    const parsed = parseYamlFile(filePath)
    if (!parsed || typeof parsed !== "object") {
      continue
    }

    const jobs = parsed.jobs && typeof parsed.jobs === "object" ? parsed.jobs : {}

    for (const [jobName, jobConfig] of Object.entries(jobs)) {
      if (!jobConfig || typeof jobConfig !== "object" || !Array.isArray(jobConfig.steps)) {
        continue
      }

      for (const step of jobConfig.steps) {
        if (!step || typeof step !== "object" || !String(step.uses || "").startsWith("actions/setup-node")) {
          continue
        }

        const withConfig = step.with && typeof step.with === "object" ? step.with : {}

        if (withConfig["node-version"]) {
          signals.push(
            makeSignal({
              rootPath,
              ecosystem: "node",
              key: "runtimeVersion",
              source: `GitHub Actions ${jobName}`,
              filePath,
              value: normalizeVersion(withConfig["node-version"]),
              fixable: true,
            })
          )
        }

        if (withConfig["node-version-file"]) {
          signals.push(
            makeSignal({
              rootPath,
              ecosystem: "node",
              key: "versionFileReference",
              source: `GitHub Actions ${jobName} version file`,
              filePath,
              value: String(withConfig["node-version-file"]).trim(),
              fixable: true,
            })
          )
        }
      }
    }
  }

  return signals
}

function readDockerSignals(rootPath) {
  const signals = []

  const rootEntries = fs.readdirSync(rootPath, { withFileTypes: true })
  const dockerfiles = rootEntries
    .filter((entry) => entry.isFile() && /^dockerfile(\..+)?$/i.test(entry.name))
    .map((entry) => path.join(rootPath, entry.name))

  for (const filePath of dockerfiles) {
    const raw = readText(filePath)
    if (!raw) {
      continue
    }

    for (const line of raw.split(/\r?\n/)) {
      const match = line.match(/^\s*FROM\s+([^\s#]+)\s*$/i)
      if (!match) {
        continue
      }

      const image = match[1]
      if (image.startsWith("node:")) {
        signals.push(
          makeSignal({
            rootPath,
            ecosystem: "node",
            key: "runtimeVersion",
            source: `Dockerfile base image (${path.basename(filePath)})`,
            filePath,
            value: normalizeVersion(image.slice("node:".length)),
          })
        )
      }

      if (image.startsWith("python:")) {
        signals.push(
          makeSignal({
            rootPath,
            ecosystem: "python",
            key: "runtimeVersion",
            source: `Dockerfile base image (${path.basename(filePath)})`,
            filePath,
            value: normalizeVersion(image.slice("python:".length)),
          })
        )
      }
    }
  }

  const composeFiles = rootEntries
    .filter((entry) => entry.isFile() && /^(docker-compose|compose)(\..+)?\.ya?ml$/i.test(entry.name))
    .map((entry) => path.join(rootPath, entry.name))

  for (const filePath of composeFiles) {
    const parsed = parseYamlFile(filePath)
    if (!parsed || !parsed.services || typeof parsed.services !== "object") {
      continue
    }

    const serviceNames = Object.keys(parsed.services)
    if (serviceNames.length > 0) {
      signals.push(
        makeSignal({
          rootPath,
          ecosystem: "containers",
          key: "services",
          source: `Docker Compose (${path.basename(filePath)})`,
          filePath,
          value: serviceNames.join(", "),
          detail: `${serviceNames.length} services`,
        })
      )
    }
  }

  return signals
}

function readNodeSignals(rootPath) {
  const signals = []

  const nvmrcPath = path.join(rootPath, ".nvmrc")
  const nvmrc = readText(nvmrcPath)
  if (nvmrc) {
    signals.push(
      makeSignal({
        rootPath,
        ecosystem: "node",
        key: "runtimeVersion",
        source: ".nvmrc",
        filePath: nvmrcPath,
        value: normalizeVersion(firstLine(nvmrc)),
        fixable: true,
      })
    )
  }

  const nodeVersionPath = path.join(rootPath, ".node-version")
  const nodeVersion = readText(nodeVersionPath)
  if (nodeVersion) {
    signals.push(
      makeSignal({
        rootPath,
        ecosystem: "node",
        key: "runtimeVersion",
        source: ".node-version",
        filePath: nodeVersionPath,
        value: normalizeVersion(firstLine(nodeVersion)),
        fixable: true,
      })
    )
  }

  const packageJsonPath = path.join(rootPath, "package.json")
  const packageJson = parseJsonFile(packageJsonPath)
  if (packageJson) {
    if (packageJson.engines && packageJson.engines.node) {
      signals.push(
        makeSignal({
          rootPath,
          ecosystem: "node",
          key: "runtimeVersion",
          source: "package.json engines.node",
          filePath: packageJsonPath,
          value: normalizeVersion(packageJson.engines.node),
          fixable: true,
        })
      )
    }

    if (packageJson.packageManager) {
      signals.push(
        makeSignal({
          rootPath,
          ecosystem: "node",
          key: "packageManager",
          source: "package.json packageManager",
          filePath: packageJsonPath,
          value: String(packageJson.packageManager).trim(),
          fixable: true,
        })
      )
    }
  }

  const devcontainerCandidates = [
    path.join(rootPath, "devcontainer.json"),
    path.join(rootPath, ".devcontainer", "devcontainer.json"),
  ]

  for (const candidate of devcontainerCandidates) {
    const devcontainer = parseJsonFile(candidate)
    if (!devcontainer) {
      continue
    }

    const nodeVersion = extractDevcontainerRuntimeVersion(devcontainer, "node")
    if (nodeVersion) {
      signals.push(
        makeSignal({
          rootPath,
          ecosystem: "node",
          key: "runtimeVersion",
          source: "devcontainer node",
          filePath: candidate,
          value: normalizeVersion(nodeVersion),
          fixable: true,
        })
      )
    }

    const pythonVersion = extractDevcontainerRuntimeVersion(devcontainer, "python")
    if (pythonVersion) {
      signals.push(
        makeSignal({
          rootPath,
          ecosystem: "python",
          key: "runtimeVersion",
          source: "devcontainer python",
          filePath: candidate,
          value: normalizeVersion(pythonVersion),
          fixable: true,
        })
      )
    }

    const serviceNames = Array.isArray(devcontainer.runServices)
      ? devcontainer.runServices
      : Array.isArray(devcontainer.services)
        ? devcontainer.services
        : []

    if (serviceNames.length > 0) {
      signals.push(
        makeSignal({
          rootPath,
          ecosystem: "containers",
          key: "services",
          source: "devcontainer services",
          filePath: candidate,
          value: serviceNames.join(", "),
          detail: `${serviceNames.length} services`,
        })
      )
    }
  }

  return [...signals, ...readGithubActionsSignals(rootPath), ...readDockerSignals(rootPath)]
}

function readPythonSignals(rootPath) {
  const signals = []

  const pythonVersionPath = path.join(rootPath, ".python-version")
  const pythonVersion = readText(pythonVersionPath)
  if (pythonVersion) {
    signals.push(
      makeSignal({
        rootPath,
        ecosystem: "python",
        key: "runtimeVersion",
        source: ".python-version",
        filePath: pythonVersionPath,
        value: normalizeVersion(firstLine(pythonVersion)),
        fixable: true,
      })
    )
  }

  const pyprojectPath = path.join(rootPath, "pyproject.toml")
  const pyprojectRaw = readText(pyprojectPath)
  if (pyprojectRaw) {
    const match = pyprojectRaw.match(/requires-python\s*=\s*["']([^"']+)["']/)
    if (match) {
      signals.push(
        makeSignal({
          rootPath,
          ecosystem: "python",
          key: "runtimeVersion",
          source: "pyproject.toml requires-python",
          filePath: pyprojectPath,
          value: normalizeVersion(match[1]),
          fixable: true,
        })
      )
    }
  }

  return signals
}

function groupSignalsByEcosystem(signals) {
  const grouped = {}
  for (const signal of signals) {
    if (!grouped[signal.ecosystem]) {
      grouped[signal.ecosystem] = []
    }
    grouped[signal.ecosystem].push(signal)
  }
  return grouped
}

function pickRecommendedValue(signals, key) {
  const candidates = signals.filter((signal) => signal.key === key && signal.value)
  if (candidates.length === 0) {
    return null
  }

  const weights = new Map()
  for (const signal of candidates) {
    const weight =
      signal.source === ".nvmrc" ||
      signal.source === ".node-version" ||
      signal.source === ".python-version"
        ? 3
        : signal.source.includes("devcontainer")
          ? 2
          : 1
    weights.set(signal.value, (weights.get(signal.value) || 0) + weight)
  }

  return [...weights.entries()].sort((left, right) => right[1] - left[1])[0][0]
}

function analyzeRuntimeDrift(ecosystem, label, signals) {
  const runtimeSignals = signals.filter((signal) => signal.key === "runtimeVersion")
  const uniqueValues = [...new Set(runtimeSignals.map((signal) => signal.value))]
  const issues = []

  if (runtimeSignals.length === 0) {
    issues.push(
      makeIssue({
        ecosystem,
        severity: "info",
        code: `${ecosystem}-missing`,
        message: `No ${label} version signals found.`,
      })
    )
    return issues
  }

  if (uniqueValues.length > 1) {
    issues.push(
      makeIssue({
        ecosystem,
        severity: "warning",
        code: `${ecosystem}-drift`,
        message: `${label} version drift detected: ${uniqueValues.join(", ")}.`,
        signals: runtimeSignals,
        suggestedValue: pickRecommendedValue(signals, "runtimeVersion"),
      })
    )
  }

  if (uniqueValues.includes("latest")) {
    issues.push(
      makeIssue({
        ecosystem,
        severity: "warning",
        code: `${ecosystem}-latest`,
        message: `${label} uses 'latest' in at least one file, which weakens reproducibility.`,
        signals: runtimeSignals.filter((signal) => signal.value === "latest"),
      })
    )
  }

  return issues
}

function analyzePackageManagers(nodeSignals) {
  const packageManagerSignals = nodeSignals.filter((signal) => signal.key === "packageManager")
  const uniqueValues = [...new Set(packageManagerSignals.map((signal) => signal.value))]
  if (uniqueValues.length <= 1) {
    return []
  }

  return [
    makeIssue({
      ecosystem: "node",
      severity: "warning",
      code: "package-manager-drift",
      message: `Package manager drift detected: ${uniqueValues.join(", ")}.`,
      signals: packageManagerSignals,
      suggestedValue: uniqueValues[0],
    }),
  ]
}

function analyzeServiceSources(containerSignals) {
  const serviceSignals = containerSignals.filter((signal) => signal.key === "services")
  const uniqueValues = [...new Set(serviceSignals.map((signal) => signal.value))]
  if (uniqueValues.length <= 1) {
    return []
  }

  return [
    makeIssue({
      ecosystem: "containers",
      severity: "info",
      code: "service-definition-drift",
      message: "Container service definitions differ between devcontainer and compose sources.",
      signals: serviceSignals,
    }),
  ]
}

function buildSummary(grouped, issues) {
  return {
    nodeSignals: (grouped.node || []).length,
    pythonSignals: (grouped.python || []).length,
    containerSignals: (grouped.containers || []).length,
    warningCount: issues.filter((issue) => issue.severity === "warning").length,
    infoCount: issues.filter((issue) => issue.severity === "info").length,
  }
}

function buildAnalysis(rootPath) {
  const signals = [...readNodeSignals(rootPath), ...readPythonSignals(rootPath)].filter((signal) => signal.value)
  const grouped = groupSignalsByEcosystem(signals)
  const issues = [
    ...analyzeRuntimeDrift("node", "Node", grouped.node || []),
    ...analyzeRuntimeDrift("python", "Python", grouped.python || []),
    ...analyzePackageManagers(grouped.node || []),
    ...analyzeServiceSources(grouped.containers || []),
  ]

  return {
    rootPath,
    signals,
    grouped,
    recommended: {
      node: pickRecommendedValue(grouped.node || [], "runtimeVersion"),
      python: pickRecommendedValue(grouped.python || [], "runtimeVersion"),
      packageManager: pickRecommendedValue(grouped.node || [], "packageManager"),
    },
    issues,
    summary: buildSummary(grouped, issues),
  }
}

function createSpec(analysis) {
  const spec = {
    schema: "v0",
    runtime: {},
    sources: analysis.signals
      .filter((signal) => signal.key === "runtimeVersion" || signal.key === "packageManager")
      .map((signal) => ({
        file: signal.relativePath,
        source: signal.source,
        ecosystem: signal.ecosystem,
        key: signal.key,
        value: signal.value,
      })),
  }

  if (analysis.recommended.node) {
    spec.runtime.node = analysis.recommended.node
  }

  if (analysis.recommended.python) {
    spec.runtime.python = analysis.recommended.python
  }

  if (analysis.recommended.packageManager) {
    spec.packageManager = analysis.recommended.packageManager
  }

  const serviceSignal = (analysis.grouped.containers || []).find((signal) => signal.key === "services")
  if (serviceSignal) {
    spec.containers = {
      services: serviceSignal.value.split(", ").filter(Boolean),
    }
  }

  return `# Generated by DevEnv VS Code extension\n${YAML.stringify(spec)}`
}

function rangeForFile(filePath, signal) {
  const vscode = getVscode()
  const content = readText(filePath)
  if (!content) {
    return new vscode.Range(0, 0, 0, 120)
  }

  const lines = content.split(/\r?\n/)
  let lineIndex = lines.findIndex((line) => signal.value && line.includes(signal.value))

  if (lineIndex === -1 && signal.source.includes("package.json")) {
    lineIndex = lines.findIndex((line) => line.includes('"engines"') || line.includes('"packageManager"'))
  }

  if (lineIndex === -1 && signal.source.includes("GitHub Actions")) {
    lineIndex = lines.findIndex((line) => line.includes("node-version"))
  }

  if (lineIndex === -1 && signal.source.includes("devcontainer")) {
    lineIndex = lines.findIndex((line) => line.includes("features") || line.includes("image"))
  }

  if (lineIndex === -1) {
    lineIndex = 0
  }

  return new vscode.Range(lineIndex, 0, lineIndex, Math.max(lines[lineIndex]?.length || 1, 1))
}

function applyDiagnostics(analysis) {
  const vscode = getVscode()
  diagnosticCollection.clear()

  const byFile = new Map()

  for (const issue of analysis.issues) {
    if (issue.severity !== "warning") {
      continue
    }

    for (const signal of issue.signals) {
      const diagnostics = byFile.get(signal.filePath) || []
      const diagnostic = new vscode.Diagnostic(
        rangeForFile(signal.filePath, signal),
        issue.message,
        vscode.DiagnosticSeverity.Warning
      )
      diagnostic.code = issue.code
      diagnostic.source = "DevEnv"
      diagnostics.push(diagnostic)
      byFile.set(signal.filePath, diagnostics)
    }
  }

  for (const [filePath, diagnostics] of byFile.entries()) {
    diagnosticCollection.set(vscode.Uri.file(filePath), diagnostics)
  }
}

function writeOutput(analysis) {
  outputChannel.clear()
  outputChannel.appendLine("DevEnv workspace scan")
  outputChannel.appendLine(`Workspace: ${analysis.rootPath}`)
  outputChannel.appendLine("")

  for (const signal of analysis.signals) {
    outputChannel.appendLine(`- [${signal.ecosystem}] ${signal.source}: ${signal.value} (${signal.relativePath})`)
  }

  outputChannel.appendLine("")
  outputChannel.appendLine("Summary")
  outputChannel.appendLine(`- Node signals: ${analysis.summary.nodeSignals}`)
  outputChannel.appendLine(`- Python signals: ${analysis.summary.pythonSignals}`)
  outputChannel.appendLine(`- Container signals: ${analysis.summary.containerSignals}`)
  outputChannel.appendLine(`- Warnings: ${analysis.summary.warningCount}`)

  if (analysis.issues.length > 0) {
    outputChannel.appendLine("")
    outputChannel.appendLine("Issues")
    for (const issue of analysis.issues) {
      outputChannel.appendLine(`- [${issue.severity}] ${issue.message}`)
    }
  }
}

function updateStatusBar(analysis) {
  if (analysis.summary.warningCount > 0) {
    statusBarItem.text = `$(warning) DevEnv ${analysis.summary.warningCount}`
    statusBarItem.tooltip = `${analysis.summary.warningCount} drift warning(s) detected`
  } else if (analysis.recommended.node || analysis.recommended.python) {
    const label = [
      analysis.recommended.node ? `Node ${analysis.recommended.node}` : null,
      analysis.recommended.python ? `Python ${analysis.recommended.python}` : null,
    ]
      .filter(Boolean)
      .join(" | ")
    statusBarItem.text = `$(check) ${label}`
    statusBarItem.tooltip = "Workspace environment looks aligned"
  } else {
    statusBarItem.text = `$(circle-slash) DevEnv unknown`
    statusBarItem.tooltip = "No runtime signals found yet"
  }

  statusBarItem.show()
}

class DevEnvItem extends getTreeItemClass() {
  constructor(label, options = {}) {
    super(label, options.collapsibleState)
    this.contextValue = options.contextValue
    this.description = options.description
    this.tooltip = options.tooltip
    this.command = options.command
    this.iconPath = options.iconPath
    this.resourceUri = options.resourceUri
  }
}

function getTreeItemClass() {
  return getVscode().TreeItem
}

class DevEnvTreeDataProvider {
  constructor() {
    const vscode = getVscode()
    this.vscode = vscode
    this.onDidChangeTreeDataEmitter = new vscode.EventEmitter()
    this.onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event
  }

  refresh() {
    this.onDidChangeTreeDataEmitter.fire()
  }

  getTreeItem(element) {
    return element
  }

  getChildren(element) {
    if (!latestAnalysis) {
      return []
    }

    if (!element) {
      return [
        new DevEnvItem("Issues", {
          collapsibleState: this.vscode.TreeItemCollapsibleState.Expanded,
          description: `${latestAnalysis.issues.length}`,
          contextValue: "issues",
        }),
        new DevEnvItem("Signals", {
          collapsibleState: this.vscode.TreeItemCollapsibleState.Expanded,
          description: `${latestAnalysis.signals.length}`,
          contextValue: "signals",
        }),
      ]
    }

    if (element.label === "Issues") {
      return latestAnalysis.issues.map((issue) => {
        const firstSignal = issue.signals[0]
        return new DevEnvItem(issue.message, {
          description: issue.ecosystem,
          tooltip: issue.message,
          iconPath: new this.vscode.ThemeIcon(issue.severity === "warning" ? "warning" : "info"),
          command: firstSignal
            ? {
                command: "vscode.open",
                title: "Open issue file",
                arguments: [this.vscode.Uri.file(firstSignal.filePath)],
              }
            : undefined,
        })
      })
    }

    if (element.label === "Signals") {
      return latestAnalysis.signals.map((signal) => {
        const resourceUri = this.vscode.Uri.file(signal.filePath)
        return new DevEnvItem(signal.source, {
          description: signal.value,
          tooltip: `${signal.relativePath}\n${signal.value}`,
          iconPath: new this.vscode.ThemeIcon("symbol-key"),
          resourceUri,
          command: {
            command: "vscode.open",
            title: "Open signal file",
            arguments: [resourceUri],
          },
        })
      })
    }

    return []
  }
}

function refreshTree() {
  if (treeDataProvider) {
    treeDataProvider.refresh()
  }
}

async function scanWorkspace(showMessage) {
  const vscode = getVscode()
  const folder = findWorkspaceFolder()

  if (!folder) {
    vscode.window.showWarningMessage("Open a workspace folder to use DevEnv.")
    return null
  }

  const analysis = buildAnalysis(folder.uri.fsPath)
  latestAnalysis = analysis
  applyDiagnostics(analysis)
  writeOutput(analysis)
  updateStatusBar(analysis)
  refreshTree()

  if (showMessage) {
    if (analysis.summary.warningCount > 0) {
      vscode.window.showWarningMessage(`DevEnv found ${analysis.summary.warningCount} drift warning(s).`)
    } else {
      vscode.window.showInformationMessage("DevEnv workspace looks aligned.")
    }
  }

  return analysis
}

async function generateSpec() {
  const vscode = getVscode()
  const analysis = await scanWorkspace(false)
  if (!analysis) {
    return
  }

  const targetPath = path.join(analysis.rootPath, "devenv.yaml")
  writeText(targetPath, createSpec(analysis))
  const document = await vscode.workspace.openTextDocument(targetPath)
  await vscode.window.showTextDocument(document)
  vscode.window.showInformationMessage("Generated devenv.yaml from detected workspace signals.")
}

function updateJsonFile(filePath, updater) {
  const current = parseJsonFile(filePath)
  if (!current) {
    return false
  }

  const next = updater(current)
  if (!next) {
    return false
  }

  writeText(filePath, `${JSON.stringify(next, null, 2)}\n`)
  return true
}

function updateYamlFile(filePath, updater) {
  const current = parseYamlFile(filePath)
  if (!current) {
    return false
  }

  const next = updater(current)
  if (!next) {
    return false
  }

  writeText(filePath, YAML.stringify(next))
  return true
}

function updateTextFile(filePath, updater) {
  const current = readText(filePath)
  if (current === null) {
    return false
  }

  const next = updater(current)
  if (!next || next === current) {
    return false
  }

  writeText(filePath, next)
  return true
}

function fixSignal(signal, suggestedValue) {
  const nextValue = suggestedValue || signal.value
  if (!signal.fixable || !nextValue) {
    return false
  }

  if (signal.source === ".nvmrc" || signal.source === ".node-version" || signal.source === ".python-version") {
    writeText(signal.filePath, `${nextValue}\n`)
    return true
  }

  if (signal.source === "package.json engines.node") {
    return updateJsonFile(signal.filePath, (json) => {
      json.engines = json.engines || {}
      json.engines.node = nextValue
      return json
    })
  }

  if (signal.source === "package.json packageManager") {
    return updateJsonFile(signal.filePath, (json) => {
      json.packageManager = nextValue
      return json
    })
  }

  if (signal.source.startsWith("devcontainer ")) {
    return updateJsonFile(signal.filePath, (json) => {
      json.features = json.features || {}
      const targetFeature = Object.keys(json.features).find((name) =>
        name.includes(signal.ecosystem === "python" ? "/python" : "/node")
      )

      if (targetFeature) {
        const current = json.features[targetFeature]
        if (typeof current === "string") {
          json.features[targetFeature] = nextValue
        } else {
          json.features[targetFeature] = { ...(current || {}), version: nextValue }
        }
        return json
      }

      if (typeof json.image === "string") {
        json.image = json.image.replace(/(node|python):[\w.-]+/, `${signal.ecosystem}:${nextValue}`)
        return json
      }

      return null
    })
  }

  if (signal.source.startsWith("GitHub Actions ")) {
    return updateYamlFile(signal.filePath, (yamlDoc) => {
      const jobs = yamlDoc.jobs || {}
      for (const jobConfig of Object.values(jobs)) {
        if (!jobConfig || typeof jobConfig !== "object" || !Array.isArray(jobConfig.steps)) {
          continue
        }

        for (const step of jobConfig.steps) {
          if (!step || typeof step !== "object" || !String(step.uses || "").startsWith("actions/setup-node")) {
            continue
          }

          step.with = step.with || {}
          if (signal.key === "versionFileReference") {
            step.with["node-version-file"] = nextValue
          } else {
            step.with["node-version"] = nextValue
          }
          return yamlDoc
        }
      }

      return null
    })
  }

  if (signal.source === "pyproject.toml requires-python") {
    return updateTextFile(signal.filePath, (text) =>
      text.replace(/requires-python\s*=\s*["'][^"']+["']/, `requires-python = "${nextValue}"`)
    )
  }

  return false
}

async function fixDrift(issueCode) {
  const vscode = getVscode()
  const analysis = latestAnalysis || (await scanWorkspace(false))
  if (!analysis) {
    return
  }

  const issue = analysis.issues.find((candidate) => candidate.code === issueCode)
  if (!issue || issue.signals.length === 0) {
    vscode.window.showInformationMessage("No fixable drift issue selected.")
    return
  }

  const suggestedValue =
    issue.suggestedValue ||
    (issue.ecosystem === "node"
      ? analysis.recommended.node
      : issue.ecosystem === "python"
        ? analysis.recommended.python
        : analysis.recommended.packageManager)

  let updatedCount = 0
  for (const signal of issue.signals) {
    if (fixSignal(signal, suggestedValue)) {
      updatedCount += 1
    }
  }

  if (updatedCount === 0) {
    vscode.window.showWarningMessage("DevEnv could not automatically fix that issue.")
    return
  }

  await scanWorkspace(false)
  vscode.window.showInformationMessage(`Updated ${updatedCount} file(s) to reduce drift.`)
}

function registerCodeActions(context) {
  const vscode = getVscode()

  const provider = {
    provideCodeActions(document, range, codeActionContext) {
      return codeActionContext.diagnostics
        .filter((diagnostic) => typeof diagnostic.code === "string" && diagnostic.source === "DevEnv")
        .map((diagnostic) => {
          const action = new vscode.CodeAction("Fix drift with DevEnv", vscode.CodeActionKind.QuickFix)
          action.command = {
            command: "devenv.fixDrift",
            title: "Fix drift with DevEnv",
            arguments: [String(diagnostic.code)],
          }
          action.diagnostics = [diagnostic]
          return action
        })
    },
  }

  context.subscriptions.push(
    vscode.languages.registerCodeActionsProvider(
      [
        { language: "json" },
        { language: "jsonc" },
        { language: "yaml" },
        { language: "plaintext" },
        { language: "toml" },
        { language: "dockerfile" },
      ],
      provider
    )
  )
}

function registerWorkspaceListeners(context) {
  const vscode = getVscode()
  const triggerScan = () => {
    scanWorkspace(false).catch(() => {})
  }

  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument(triggerScan),
    vscode.workspace.onDidChangeWorkspaceFolders(triggerScan)
  )

  const patterns = [
    "**/.nvmrc",
    "**/.node-version",
    "**/.python-version",
    "**/package.json",
    "**/pyproject.toml",
    "**/devcontainer.json",
    "**/.devcontainer/devcontainer.json",
    "**/.github/workflows/*.{yml,yaml}",
    "**/Dockerfile*",
    "**/{docker-compose,compose}*.{yml,yaml}",
  ]

  for (const pattern of patterns) {
    const watcher = vscode.workspace.createFileSystemWatcher(pattern)
    watcher.onDidChange(triggerScan)
    watcher.onDidCreate(triggerScan)
    watcher.onDidDelete(triggerScan)
    context.subscriptions.push(watcher)
  }
}

function activate(context) {
  const vscode = getVscode()

  diagnosticCollection = vscode.languages.createDiagnosticCollection("devenv")
  outputChannel = vscode.window.createOutputChannel("DevEnv")
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100)
  statusBarItem.command = "devenv.checkDrift"
  treeDataProvider = new DevEnvTreeDataProvider()

  context.subscriptions.push(diagnosticCollection, outputChannel, statusBarItem)
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider("devenv.inspector", treeDataProvider),
    vscode.commands.registerCommand("devenv.scanWorkspace", async () => {
      await scanWorkspace(true)
      outputChannel.show(true)
    }),
    vscode.commands.registerCommand("devenv.checkDrift", async () => {
      const analysis = await scanWorkspace(true)
      if (analysis) {
        outputChannel.show(true)
      }
    }),
    vscode.commands.registerCommand("devenv.generateSpec", async () => {
      await generateSpec()
    }),
    vscode.commands.registerCommand("devenv.fixDrift", async (issueCode) => {
      await fixDrift(issueCode)
    }),
    vscode.commands.registerCommand("devenv.refreshInspector", async () => {
      await scanWorkspace(false)
    })
  )

  registerCodeActions(context)
  registerWorkspaceListeners(context)
  scanWorkspace(false).catch(() => {})
}

function deactivate() {}

module.exports = {
  activate,
  deactivate,
  _internal: {
    buildAnalysis,
    createSpec,
    normalizeVersion,
    extractDevcontainerRuntimeVersion,
    stripJsonComments,
    readGithubActionsSignals,
  },
}
