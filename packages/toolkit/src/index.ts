/**
 * What a build script or a plugin calls, and nothing else.
 *
 * `specs/10-compiler-and-tooling.spec.md` section 2 draws the line: only high-level requests,
 * results, configuration, documented diagnostics and generated public contracts are consumer-facing,
 * and everything under them is an internal version boundary. So what this publishes is the four
 * project verbs, the interchange and authoring functions, the configuration and catalog parsers,
 * the extension surface a plugin registers through, the schemas of the public file formats, and
 * every type those signatures hold. The command line does not come through here; it imports the
 * modules it needs, so a name is published because a caller outside Atlas needs it rather than
 * because Atlas itself uses it.
 *
 * Section 1 of `specs/10-compiler-and-tooling.spec.md` keeps this package the whole of Atlas's
 * build side, so nothing here reaches for a consumer's compiler, build system, or workspace
 * layout. Importing it starts no compilation, no watch and no write, which is what lets a build
 * script import one type from it without paying for anything else.
 */

export { formatAtlasCatalog, parseAtlasCatalog } from './catalog.js';
export type {
  AtlasCatalog,
  AtlasCatalogFamily,
  AtlasCatalogMessage,
  AtlasCatalogParseOptions,
  AtlasCatalogRole,
  AtlasEmptyCatalogMessage,
  AtlasInputLiteral,
  AtlasInputRefinement,
  AtlasSlotRefinement,
  AtlasSlotShape,
  AtlasTextCatalogMessage,
} from './catalog.js';
export {
  EXTENSION_DESCRIPTOR_PROFILE,
  ATLAS_EXTENSION_REGISTRY_PROFILE,
  atlasExtensionDescriptor,
  defineAtlasExtensionRegistry,
} from './extensions.js';
export type {
  AtlasExtensionDescriptor,
  AtlasExtensionDescriptorInput,
  AtlasExtensionRegistry,
  ExtensionValueType,
  AtlasFormattingAdapterDescriptorInput,
  AtlasIdentifierSegmentDescriptorInput,
  AtlasMessageFunctionDescriptorInput,
  AtlasParsingAdapterDescriptorInput,
  AtlasRichSlotKindDescriptorInput,
} from './extensions.js';
export { parseAtlasConfiguration } from './configuration.js';
export type {
  AtlasConfigurationParseOptions,
  AtlasInitConfiguration,
  AtlasProjectConfiguration,
} from './configuration.js';
export type {
  AtlasDiagnostic,
  AtlasDiagnosticCode,
  AtlasDiagnosticSeverity,
  AtlasFailure,
  AtlasResult,
  AtlasSourcePosition,
  AtlasSourceSpan,
  AtlasSuccess,
} from './diagnostics.js';
export type { AtlasProviderId, AtlasScopeId } from './identities.js';
export type {
  AtlasMessageAttributeMap,
  AtlasMessageAttributeValue,
  AtlasMessageCatchallVariantKey,
  AtlasMessageCustomFunction,
  AtlasMessageDeclaration,
  AtlasMessageExpression,
  AtlasMessageFunctionReference,
  AtlasMessageLiteral,
  AtlasMessageLiteralVariantKey,
  AtlasMessageMarkup,
  AtlasMessageOptionMap,
  AtlasMessagePattern,
  AtlasMessagePatternPart,
  AtlasMessageSemanticModel,
  AtlasMessageValueReference,
  AtlasMessageVariableReference,
  AtlasMessageVariant,
  AtlasMessageVariantKey,
  AtlasPatternMessageSemanticModel,
  AtlasSelectMessageSemanticModel,
} from './message-format.js';
// `AtlasMessageCustomFunction` names this type, so a caller that builds one needs it. The table
// itself stays internal: it is the specification's own vocabulary, not something an application
// declares against.
export type { AtlasMessageOperandKind } from './message-function-options.js';
export type { AtlasLocale } from './locales.js';
export {
  ATLAS_PSEUDO_LOCALE_CONTRACTED,
  ATLAS_PSEUDO_LOCALE_EXPANDED,
  createAtlasPseudoCatalog,
} from './pseudo-localization.js';
export type {
  AtlasPseudoLocaleTransform,
  AtlasPseudoLocaleOptions,
} from './pseudo-localization.js';
export { exportAtlasXliff22, importAtlasXliff22 } from './xliff.js';
export type {
  AtlasXliffExportRequest,
  AtlasXliffImportRequest,
} from './xliff.js';
export {
  ATLAS_TOOLKIT_EVENT_CODES,
  ATLAS_TOOLKIT_OBSERVABILITY_PROFILE,
} from './observability.js';
export type {
  AtlasToolkitEventCode,
  AtlasToolkitEventPhase,
  AtlasToolkitEventStatus,
  AtlasToolkitObservabilityEvent,
  AtlasToolkitObservabilityOptions,
  AtlasToolkitObservabilitySink,
} from './observability.js';
export { diffAtlasCatalogSets } from './catalog-diff.js';
export type {
  AtlasCatalogDiff,
  AtlasCatalogDiffEntry,
  AtlasCatalogDiffKind,
  AtlasCatalogDiffRequest,
  AtlasCatalogDiffSnapshot,
  AtlasCatalogIdentityMove,
} from './catalog-diff.js';
export { createAtlasMigrationPlan } from './authoring-transaction.js';
export type {
  AtlasAuthoredChangeKind,
  AtlasAuthoredChangePlan,
  AtlasAuthoredFileChange,
  AtlasAuthoredFileChangeInput,
  AtlasMigrationPlanRequest,
} from './authoring-transaction.js';
export { planAtlasMessageRefactor } from './refactoring.js';
export type {
  AtlasMessageRefactorIdentity,
  AtlasMessageRefactorPlan,
  AtlasMessageRefactorRequest,
} from './refactoring.js';
export type { AtlasCanonicalJsonValue } from './canonical-json.js';
export { ATLAS_OUTPUT_PLAN_PROFILE } from './output-plan.js';
export type {
  AtlasOutputFileInput,
  AtlasOutputPlan,
  AtlasPlannedOutputFile,
} from './output-plan.js';
export type {
  AtlasApplyOutputPlanResult,
  AtlasOutputFreshness,
} from './output-host.js';
export {
  ATLAS_CATALOG_DESCRIPTOR_PROFILE,
  COMPILED_IR_PROFILE,
  RESOURCE_SUMMARY_PROFILE,
} from './compiled-artifacts.js';
export type {
  ArtifactAddress,
  AtlasOwnerIdentity,
  CatalogResourceSummary,
  CatalogSetArtifact,
  CatalogSetDescriptor,
  AtlasCompiledCatalog,
  AtlasCompiledCatalogKey,
  AtlasCompiledLocalArtifacts,
  AtlasCompiledMessage,
  MessageResourceSummary,
  ProviderCatalogSet,
  RecoveryRepresentation,
} from './compiled-artifacts.js';
export {
  ATLAS_COMPILER_STATE_PROFILE,
  compileAtlasProject,
} from './compiler.js';
export type {
  AtlasCompileProjectRequest,
  AtlasCompileProjectResult,
  AtlasCompilerAnalysisInput,
  AtlasCompilerInputDigest,
  AtlasCompilerState,
  AtlasInvalidationDecision,
} from './compiler.js';
export { ATLAS_GENERATED_ABI_PROFILE } from './semantic-model.js';
export type {
  AtlasEffectiveInputContract,
  AtlasEffectiveSlotContract,
  AtlasPortableTypeId,
  AtlasReferencedExtension,
  AtlasSemanticFamily,
  AtlasSemanticFamilyMember,
  AtlasSemanticFamilySegment,
  AtlasSemanticGraph,
  AtlasSemanticMessage,
  AtlasSemanticScope,
  AtlasSemanticTargetMessage,
} from './semantic-model.js';
export type {
  AtlasAnalysisSource,
  AtlasApplicationAnalysis,
  AtlasClaimedRouteSegment,
  AtlasComponentTemplateAnalysis,
  AtlasMessageUsage,
  AtlasRoutePolicyDeclaration,
  AtlasRouteProjection,
} from './static-analysis.js';
export {
  checkAtlasProject,
  cleanAtlasProject,
  compileAtlasProjectFromDisk,
  formatAtlasProject,
  generateAtlasProject,
  initializeAtlasProject,
  uninstallAtlasProject,
  watchAtlasProject,
} from './project-host.js';
export type {
  AtlasCheckProjectOptions,
  AtlasCheckProjectResult,
  AtlasCleanProjectOptions,
  AtlasFormatProjectOptions,
  AtlasFormatProjectResult,
  AtlasGenerateProjectOptions,
  AtlasGenerateProjectResult,
  AtlasInitProjectOptions,
  AtlasInitProjectResult,
  AtlasProjectCompilation,
  AtlasProjectSelection,
  AtlasUninstallProjectOptions,
  AtlasUninstallProjectResult,
  AtlasWatchCycle,
  AtlasWatchProjectOptions,
  AtlasWatchProjectResult,
} from './project-host.js';
export {
  ATLAS_CLI_RESULT_SCHEMA,
  ATLAS_CLI_WATCH_EVENT_SCHEMA,
  ATLAS_CONFIGURATION_SCHEMA,
  ATLAS_EXTENSION_REGISTRY_SCHEMA,
  ATLAS_SOURCE_CATALOG_SCHEMA,
  ATLAS_TARGET_CATALOG_SCHEMA,
} from './schemas.js';
