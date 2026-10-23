// Browser-side trials use the released capture/batch/cache primitives.
export async function capturedHeadTrials({ort, manifest, reverse, CapturedSession, FeatureSession, FusedGpuHead, GpuArgMax}) {
  const device = ort.env.webgpu.device, lines = [], inputs = [], tensors = [], measurements = {};
  try {
  for (const entry of manifest.scales['1']) {
    const data = new Float32Array(await (await fetch('/inputs/' + entry.file)).arrayBuffer()), [, , height, width] = entry.dims;
    if (height !== 32) throw Error('Development line height differs from the runtime');
    entry.indices.forEach((index, n) => {
      const actual = entry.widths[n], image = new Float32Array(32 * actual);
      for (let y = 0; y < 32; y++) image.set(data.subarray((n * 32 + y) * width, (n * 32 + y) * width + actual), y * actual);
      lines.push({index, width: actual, image});
    });
  }
  lines.sort((a, b) => a.width - b.width || a.index - b.index);
  if (lines.length !== 128 || new Set(lines.map(line => line.index)).size !== 128) throw Error('Expected the frozen 128-line development sample');
  const group = (selected, paddedWidth) => {
    const width = paddedWidth || Math.ceil(Math.max(...selected.map(line => line.width)) / 256) * 256;
    if (selected.length > 16 || selected.some(line => line.width > width)) throw Error('Invalid captured batch');
    const data = new Float32Array(selected.length * 32 * width);
    selected.forEach((line, n) => {for (let y = 0; y < 32; y++) data.set(line.image.subarray(y * line.width, (y + 1) * line.width), (n * 32 + y) * width);});
    const buffer = device.createBuffer({size: data.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST});
    inputs.push(buffer); device.queue.writeBuffer(buffer, 0, data);
    const image = ort.Tensor.fromGpuBuffer(buffer, {dataType: 'float32', dims: [selected.length, 1, 32, width]}); tensors.push(image);
    const widths = new ort.Tensor('int64', BigInt64Array.from(selected, line => BigInt(line.width)), [selected.length]); tensors.push(widths);
    return {width, count: selected.length, indices: selected.map(line => line.index), input: {image, widths}};
  };
  const widest = lines.slice(-16), mixed = [];
  for (let start = 0; start < lines.length; start += 16) mixed.push(group(lines.slice(start, start + 16)));
  const profiles = [
    {name: 'document_batches', groups: mixed, padding_stress: false},
    {name: 'narrow', groups: [group(lines.slice(0, 16))], padding_stress: false},
    {name: 'padded_2048', groups: [group(widest, 2048)], padding_stress: true},
    {name: 'padded_4096', groups: [group(widest, 4096)], padding_stress: true},
    {name: 'tail_3', groups: [group(widest.slice(-3))], padding_stress: false},
  ];
  const pressure = {name: 'cache_pressure', padding_stress: true,
    groups: [256, 512, 1024, 1536, 2048, 2560, 3072].map(width => group(lines.filter(line => line.width <= width).slice(-16), width))};
  const describe = profile => ({padding_stress: profile.padding_stress, actual_lines: profile.groups.reduce((sum, value) => sum + value.count, 0),
    widths: profile.groups.map(value => value.width), actual_batch_sizes: profile.groups.map(value => value.count), fixed_session_batch: 16,
    executed_pixels: profile.groups.reduce((sum, value) => sum + 16 * 32 * value.width, 0)});
  const same = (a, b) => a.length === b.length && a.every((value, index) => value.length === b[index].length && value.every((word, j) => word === b[index][j]));
  const owned = session => {
    const bytes = [...session.slots.values()].flatMap(slot => slot.buffers).reduce((sum, buffer) => sum + buffer.size, 0);
    if (bytes !== session.bytes || bytes > 256 * 1024 * 1024 || session.slots.size > 8) throw Error('Captured buffer inventory differs from its budget');
    return {bytes, widths: [...session.slots.keys()], shapes: session.slots.size};
  };
  const modes = ['released', 'fresh', 'reused', 'packed', 'combined'];
  const comparisons = [['fresh', 'reused'], ['fresh', 'packed'], ['fresh', 'combined'], ['released', 'combined']];
  const reducer = new GpuArgMax(device); await reducer.pipeline;
    for (const kind of reverse ? ['light', 'standard'] : ['standard', 'light']) {
      const heads = {}, sessions = []; let native, feature;
      try {
        const binary = await (await fetch(`/${kind}/head`)).arrayBuffer(), [channels, classes] = new Uint32Array(binary, 0, 2);
        for (const mode of modes.slice(1)) heads[mode] = await FusedGpuHead.create(device, binary, {
          reuseBuffers: mode === 'reused' || mode === 'combined', packedWeights: mode === 'packed' || mode === 'combined',
        });
        const load = async name => new Uint8Array(await (await fetch(`/${kind}/${name}`)).arrayBuffer());
        native = await CapturedSession.create(ort, await load('model'), {}, 16, classes, true, 8); sessions.push(native);
        feature = await FeatureSession.create(ort, await load('features'), {}, 16, true, 8, heads.fresh); sessions.push(feature);
        async function run(mode, profile) {
          const predictions = [];
          if (mode !== 'released') feature.head = heads[mode];
          for (const {input} of profile.groups) {
            const out = await (mode === 'released' ? native : feature).run(input);
            try {predictions.push(mode === 'released' ? await reducer.run(out.logits) : out.class_ids.data);}
            finally {for (const value of Object.values(out)) value.dispose();}
          }
          return predictions;
        }
        const references = new Map(), checks = [];
        const warm = async profile => {
          const reference = {};
          for (const mode of modes) reference[mode] = await run(mode, profile);
          for (const mode of modes.slice(2)) if (!same(reference.fresh, reference[mode])) throw Error(`${kind}/${profile.name}/${mode}: classifier IDs changed`);
          references.set(profile.name, reference);
          checks.push({profile: profile.name, fused_variants_exact: true,
            timestep_ids: reference.fresh.reduce((sum, value) => sum + value.length, 0),
            released_fused_changed_ids: reference.fresh.reduce((sum, value, n) => sum + value.reduce((count, word, j) => count + Number(word !== reference.released[n][j]), 0), 0)});
        };
        for (const profile of profiles) await warm(profile);
        const steadyInventory = {released: owned(native), feature: owned(feature)};
        const runs = [], pairs = [], ordered = reverse ? [...profiles].reverse() : profiles;
        measurements[kind] = {channels, classes, capture_enabled: true, input_location: 'gpu-buffer', fixed_batch: 16,
          profiles: Object.fromEntries([...profiles, pressure].map(value => [value.name, describe(value)])), checks,
          steady_owned_buffers: steadyInventory, pairs, runs};
        const measure = async (mode, profile, phase, block, order) => {
          const session = mode === 'released' ? native : feature, head = heads[mode];
          const builds = session.createdSlots, allocationCount = head?.workspaceAllocations || 0;
          const started = performance.now(), actual = await run(mode, profile), seconds = (performance.now() - started) / 1000;
          if (!same(actual, references.get(profile.name)[mode])) throw Error(`${kind}/${profile.name}/${mode}: output changed during timing`);
          const newBuilds = session.createdSlots - builds, allocations = head ? head.workspaceAllocations - allocationCount : null;
          if (phase === 'steady' && newBuilds) throw Error('Steady working set unexpectedly rebuilt a GPU session');
          if ((mode === 'reused' || mode === 'combined') && allocations) throw Error('Warmed scratch buffers were allocated again');
          const result = {phase, profile: profile.name, mode, block, order, seconds, gpu_session_builds: newBuilds, workspace_allocations: allocations};
          runs.push(result); return result;
        };
        for (const profile of ordered) {
          for (const [pairIndex, [a, b]] of (reverse ? [...comparisons].reverse() : comparisons).entries()) {
          const ratios = [];
          for (let block = 0; block < 2; block++) {
            const inverted = (block + pairIndex + Number(reverse)) % 2, order = inverted ? [b, a, a, b] : [a, b, b, a], sums = {[a]: 0, [b]: 0};
            for (const mode of order) {const result = await measure(mode, profile, 'steady', block, inverted ? 'BAAB' : 'ABBA');sums[mode] += result.seconds;}
            ratios.push(sums[a] / sums[b]);
          }
          pairs.push({profile: profile.name, control: a, candidate: b, block_ratios: ratios,
            matched_ratio: Math.exp(ratios.reduce((sum, value) => sum + Math.log(value), 0) / ratios.length)});
          }
          console.log(`captured: ${kind} ${profile.name} complete`);
          await globalThis.recordCapturedTrial({phase: 'steady', model: kind, profile: profile.name, measurements});
        }
        // Seven widths fit the shape-count limit but exceed the original logits-buffer budget.
        await warm(pressure);
        const pressureOrder = reverse ? ['combined', 'released', 'released', 'combined'] : ['released', 'combined', 'combined', 'released'];
        const pressureSums = {released: 0, combined: 0};
        for (const mode of pressureOrder) {const result = await measure(mode, pressure, 'cache_pressure', 0, reverse ? 'BAAB' : 'ABBA');pressureSums[mode] += result.seconds;}
        const inventory = {released: owned(native), feature: owned(feature)};
        const pressureRuns = runs.filter(value => value.phase === 'cache_pressure');
        if (!pressureRuns.some(value => value.mode === 'released' && value.gpu_session_builds > 0)) throw Error('Cache-pressure fixture did not exceed the released buffer budget');
        if (pressureRuns.some(value => value.mode === 'combined' && value.gpu_session_builds > 0)) throw Error('Feature working set did not stay resident');
        Object.assign(measurements[kind], {pressure_owned_buffers: inventory,
          weights: Object.fromEntries(Object.entries(heads).map(([mode, head]) => [mode, {bytes: head.weight.size,
            retained_workspace_bytes: head.workspace?.buffers.reduce((sum, buffer) => sum + buffer.size, 0) || 0}])),
          pressure_ratio: pressureSums.released / pressureSums.combined});
        console.log(`captured: ${kind} cache pressure complete`);
        await globalThis.recordCapturedTrial({phase: 'cache_pressure', model: kind, measurements});
      } finally {
        const releases = await Promise.allSettled(sessions.map(session => session.release()));
        for (const head of Object.values(heads)) head.release();
        const failure = releases.find(value => value.status === 'rejected'); if (failure) throw failure.reason;
      }
    }
    return measurements;
  } finally {
    for (const tensor of tensors) tensor.dispose();
    for (const buffer of inputs) buffer.destroy();
  }
}
