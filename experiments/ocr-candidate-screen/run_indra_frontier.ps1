param(
    [ValidateSet('prepare', 'kernels', 'pages', 'build-custom', 'custom', 'previews')][string]$Phase = 'kernels',
    [string]$Python = $env:OCR_BUILD_PYTHON,
    [string]$DataRoot = $env:OCR_DATA_ROOT,
    [string]$HuggingFaceCache = $env:HF_HUB_CACHE,
    [string[]]$Only = @(),
    [switch]$SkipBuild,
    [ValidateSet('tiles', 'fma', 'depthwise', 'fmadw', 'sgemm4dw')][string]$CustomKernel,
    [ValidateSet(3, 7)][int]$WarmRounds = 3
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$workspace = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
Set-Location -LiteralPath $workspace
$root = 'benchmarks/local-data/ocr-candidate-screen/speed-frontier'

function Invoke-TrainingPython([string]$File, [string[]]$Arguments) {
    & wsl -d Ubuntu --cd $workspace --exec env OMP_NUM_THREADS=2 MKL_NUM_THREADS=2 HF_HUB_OFFLINE=1 ('HF_HUB_CACHE=' + $HuggingFaceCache) $Python $File @Arguments
    if ($LASTEXITCODE) { throw ('Python candidate check failed: ' + $File) }
}

if ($Phase -eq 'prepare') {
    if (-not $Python -or -not $DataRoot -or -not $HuggingFaceCache) { throw 'Set OCR_BUILD_PYTHON, OCR_DATA_ROOT and HF_HUB_CACHE' }
    if (Test-Path ($root + '/channel64/running.pid')) { throw 'Channel training still owns its checkpoint lock' }
    $training = Get-Content -LiteralPath ($root + '/channel64/indra/result.json') -Raw | ConvertFrom-Json
    if (-not $training.completed) { throw 'Channel training did not complete' }
    $common = @('--data-root', $DataRoot, '--assets-root', 'legal-browser-ocr/assets')
    foreach ($action in @('student', 'compact')) {
        Invoke-TrainingPython 'experiments/ocr-candidate-screen/optimize_indra.py' (@($action, '--source-root', ($root + '/channel64')) + $common)
    }
    Invoke-TrainingPython 'experiments/ocr-candidate-screen/lowlevel_indra.py' (@('head', '--source-root', ($root + '/channel64'), '--output', ($root + '/head-channel64'), '--name', 'head64') + $common)
    Invoke-TrainingPython 'experiments/ocr-candidate-screen/lowlevel_indra.py' (@('spatial', '--source-root', ($root + '/channel64'), '--output', ($root + '/spatial'), '--name', 'c64spatial', '--width-scale', '1') + $common)
    return
}

if ($Phase -in @('pages', 'previews')) {
    $family = 'speed-frontier'
    $noPreviewsPackage = $CustomKernel -or $Phase -eq 'previews'
    if ($noPreviewsPackage) { $family = 'speed-pipeline' }
    $pageCases = @(
        @('control-before', 'fp32', '.76', 'profiling'),
        @('c64-baseline', 'student10c64ids', '1', 'profiling'),
        @('c64-sgemm', 'student10c64ids', '1', 'sgemm'),
        @('turbo-sgemm', 'fp32', '.76', 'sgemm'),
        @('quality-sgemm', 'quality', '1', 'sgemm'),
        @('student8-full', 'student8ids', '1', ''),
        @('student8-sgemm', 'student8ids', '1', 'sgemm'),
        @('student8-pool4', 'student8ids', '1', 'sgemm', '4'),
        @('student8-detector896', 'student8ids', '1', 'sgemm', '6', '896'),
        @('student8-detector1024', 'student8ids', '1', 'sgemm', '6', '1024'),
        @('control-after', 'fp32', '.76', 'profiling')
    )
    if ($CustomKernel) {
        $pageCases = @(
            @('kernel-control-before', 'student8ids', '1', 'sgemm', '6', '896', 'default'),
            @('kernel-balanced', 'student8ids', '1', $CustomKernel, '6', '896', 'default'),
            @('kernel-control-after', 'student8ids', '1', 'sgemm', '6', '896', 'default'),
            @('kernel-quality', 'quality', '1', $CustomKernel, '6', '768', 'default')
        )
    }
    if ($Phase -eq 'previews') {
        $pageCases = @(
            @('preview-control-before', 'student8ids', '1', 'sgemm', '6', '896', 'thumbnail'),
            @('no-previews', 'student8ids', '1', 'sgemm', '6', '896', 'default'),
            @('preview-control-after', 'student8ids', '1', 'sgemm', '6', '896', 'thumbnail')
        )
    }
    $packages = @{}
    foreach ($case in $pageCases) {
        if ($Only.Count -and $case[0] -notin $Only) { continue }
        $packages[$case[1] + '/' + $case[3]] = @($case[1], $case[3])
    }
    if (-not $packages.Count) { throw 'No matching page scenario' }
    if (-not $SkipBuild) {
        Push-Location 'legal-browser-ocr'
        try {
            foreach ($package in $packages.Values) {
                foreach ($builder in @('build-runtime.mjs', 'build-single-html.mjs')) {
                    $buildArgs = @('indra', 'detectors', ('pack=' + $package[0]))
                    if ($package[1]) { $buildArgs += 'kernels=' + $package[1] }
                    if ($noPreviewsPackage) { $buildArgs += 'no-previews' }
                    node $builder @buildArgs
                    if ($LASTEXITCODE) { throw ('Package build failed: ' + $package[0]) }
                }
            }
        } finally { Pop-Location }
    }
    foreach ($case in $pageCases) {
        if ($Only.Count -and $case[0] -notin $Only) { continue }
        Write-Output ('QUIET FULL DOCUMENT CASE: ' + $case[0])
        $pool = if ($case.Count -gt 4) { $case[4] } else { '6' }
        $side = if ($case.Count -gt 5) { $case[5] } else { '768' }
        $preview = if ($case.Count -gt 6) { $case[6] } else { 'thumbnail' }
        $query = 'pool=' + $pool + '&layoutWorkers=4&package=detectors&detector=indra&detectorSide=' + $side + '&pack=' + $case[1]
        if ($preview -ne 'default') { $query += '&preview=' + $preview }
        if ($noPreviewsPackage) { $query += '&noPreviewsPackage=1' }
        if ($case[3]) { $query += '&kernels=' + $case[3] }
        $output = 'benchmarks/local-data/ocr-candidate-screen/browser/full-test/latest/desktop/' + $family + '/' + $case[0]
        node experiments/ocr-candidate-screen/browser_benchmark.mjs 'benchmarks/local-data/ocr-candidate-screen/browser/full-test/inputs/manifest.json' $output indra $case[2] $query standalone $WarmRounds
        if ($LASTEXITCODE) { throw ('Full document benchmark failed: ' + $case[0]) }
    }
    node experiments/ocr-candidate-screen/verify_browser_packages.mjs 'benchmarks/local-data/ocr-candidate-screen/browser/full-test/latest/desktop' $family
    if ($LASTEXITCODE) { throw 'Full document package verification failed' }
    return
}

if ($Phase -eq 'build-custom') {
    if (-not $Python) { throw 'Set OCR_BUILD_PYTHON to the existing build Python' }
    & wsl -d Ubuntu --cd $workspace --exec bash -n experiments/ocr-candidate-screen/build_frontier_runtime.sh
    if ($LASTEXITCODE) { throw 'Build helper syntax check failed' }
    & wsl -d Ubuntu --cd $workspace --exec bash experiments/ocr-candidate-screen/build_sgemm_tiles.sh legal-browser-ocr/assets/indra-kernels/numeric
    if ($LASTEXITCODE) { throw 'Numeric kernel compile failed' }
    node experiments/ocr-candidate-screen/check_sgemm_tiles.mjs legal-browser-ocr/assets/indra-kernels/numeric ($root + '/custom-kernels/numeric-checks.json')
    if ($LASTEXITCODE) { throw 'Numeric kernel checks failed' }
    foreach ($mode in @('tiles', 'fma', 'depthwise', 'fmadw')) {
        Write-Output ('BUILD CUSTOM KERNEL: ' + $mode)
        & wsl -d Ubuntu --cd $workspace --exec env ('OCR_BUILD_PYTHON=' + $Python) bash experiments/ocr-candidate-screen/build_frontier_runtime.sh legal-browser-ocr/assets/indra-kernels/operators.config ('legal-browser-ocr/assets/indra-kernels/' + $mode) $mode
        if ($LASTEXITCODE) { throw ('Custom runtime compile failed: ' + $mode) }
    }
    return
}

if ($Phase -eq 'custom') {
    $models = 'quality:1,fp32:.76,student8ids:1'
    $kernelCases = @(@('before', 'sgemm'), @('tiles', 'tiles'), @('fma', 'fma'), @('depthwise', 'depthwise'), @('fmadw', 'fmadw'), @('after', 'sgemm'))
    $customRoot = $root + '/custom-kernels'
    if ($CustomKernel) {
        $kernelCases = @(@('before', 'sgemm'), @($CustomKernel, $CustomKernel), @('after', 'sgemm'))
        $customRoot += '/' + $CustomKernel
    }
    foreach ($case in $kernelCases) {
        Write-Output ('QUIET CUSTOM KERNEL CASE: ' + $case[0])
        node experiments/ocr-candidate-screen/wasm_kernel_benchmark.mjs ($root + '/inputs/manifest.json') ($customRoot + '/' + $case[0]) $models ('legal-browser-ocr/assets/indra-kernels/' + $case[1])
        if ($LASTEXITCODE) { throw ('Custom kernel benchmark failed: ' + $case[0]) }
    }
    return
}

$cases = 'quality:1,fp32:.76,student8ids:1,student6ids:1,student10c64ids:1,qspatialids:1,s8spatialids:1,tspatialids:.76,c64spatialids:1'
foreach ($case in @(@('micro-before', 'profiling'), @('micro-sgemm', 'sgemm'), @('micro-after', 'profiling'))) {
    Write-Output ('QUIET KERNEL CASE: ' + $case[0])
    node experiments/ocr-candidate-screen/wasm_kernel_benchmark.mjs ($root + '/inputs/manifest.json') ($root + '/' + $case[0]) $cases ('legal-browser-ocr/assets/indra-kernels/' + $case[1])
    if ($LASTEXITCODE) { throw ('Kernel sweep failed: ' + $case[0]) }
}
foreach ($case in @(@('head-quality', 'headquality', 'profiling', 'head-quality-timing'), @('head-quality', 'headquality', 'sgemm', 'head-quality-sgemm'), @('head-channel64', 'head64', 'sgemm', 'head-channel64-timing'))) {
    Write-Output ('QUIET CLASSIFIER CASE: ' + $case[3])
    node experiments/ocr-candidate-screen/wasm_kernel_benchmark.mjs ($root + '/' + $case[0] + '/manifest.json') ($root + '/' + $case[3]) ($case[1] + ':1,' + $case[1] + ':1:fused') ('legal-browser-ocr/assets/indra-kernels/' + $case[2])
    if ($LASTEXITCODE) { throw ('Classifier sweep failed: ' + $case[3]) }
}
Write-Output 'Quiet kernel and classifier sweep complete'
