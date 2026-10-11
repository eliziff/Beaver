param()
$ErrorActionPreference = 'Stop'
$requiredBytes = 4410358784L
if ($env:COURTLISTENER_BUDGET_WRITER -ne '1' -or $env:COURTLISTENER_REQUIRED_BYTES -ne [string]$requiredBytes) {
    throw 'Run under experiments/courtlistener-renditions/budget.py writer() + require_bytes(4410358784), holding the writer through this process.'
}
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$owner = Join-Path $root 'benchmarks/local-data/courtlistener-renditions/all-collections/catalog'
$base = 'https://com-courtlistener-storage.s3-us-west-2.amazonaws.com/'
$captured = [DateTime]::UtcNow.ToString('o')
Add-Type -AssemblyName System.Net.Http
$client = [Net.Http.HttpClient]::new()
$client.Timeout = [TimeSpan]::FromSeconds(30)
$payloads = @{}
$originals = [Collections.Generic.List[object]]::new()
function Hash-Bytes([byte[]]$bytes) {
    $hash = [Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($hash.ComputeHash($bytes))).Replace('-', '').ToLowerInvariant() }
    finally { $hash.Dispose() }
}
function Fetch([string]$url, [int]$limit = 1048576, [string]$method = 'GET') {
    $request = [Net.Http.HttpRequestMessage]::new([Net.Http.HttpMethod]::new($method), $url)
    if ($url.StartsWith('https://www.courtlistener.com/')) { $request.Headers.Accept.ParseAdd('application/json') }
    $response = $null; $stream = $null; $memory = [IO.MemoryStream]::new()
    try {
        $response = $client.SendAsync($request, [Net.Http.HttpCompletionOption]::ResponseHeadersRead).GetAwaiter().GetResult()
        if ($method -ne 'HEAD' -and $response.Content.Headers.ContentLength -gt $limit) { throw "Metadata exceeds bound: $url" }
        if ($method -ne 'HEAD') {
            $stream = $response.Content.ReadAsStreamAsync().GetAwaiter().GetResult()
            $buffer = [byte[]]::new(16384)
            while (($count = $stream.Read($buffer, 0, $buffer.Length)) -gt 0) {
                if ($memory.Length + $count -gt $limit) { throw "Metadata exceeds bound: $url" }
                $memory.Write($buffer, 0, $count)
            }
        }
        return @{ url=$url; method=$method; status=[int]$response.StatusCode; content_length=$response.Content.Headers.ContentLength; etag=[string]$response.Headers.ETag; content=$memory.ToArray() }
    } finally {
        if ($stream) { $stream.Dispose() }; $memory.Dispose()
        if ($response) { $response.Dispose() }; $request.Dispose()
    }
}
function Retain([string]$name, $response) {
    if ($payloads.ContainsKey($name)) { throw "Duplicate metadata original: $name" }
    $payloads[$name] = [byte[]]$response.content
    $proof = [ordered]@{ path=$name; url=$response.url; method=$response.method; status=$response.status; bytes=$response.content.Length; sha256=(Hash-Bytes $response.content); etag=$response.etag }
    $originals.Add($proof)
    return $proof
}
function Listing([string]$prefix, [string]$name, [string]$token = '', [string]$delimiter = '', [int]$maximumKeys = 1000) {
    $url = $base + '?list-type=2&prefix=' + [Uri]::EscapeDataString($prefix) + '&max-keys=' + $maximumKeys
    if ($token) { $url += '&continuation-token=' + [Uri]::EscapeDataString($token) }
    if ($delimiter) { $url += '&delimiter=' + [Uri]::EscapeDataString($delimiter) }
    $response = Fetch $url
    if ($response.status -ne 200) { throw "Listing returned HTTP $($response.status): $url" }
    $proof = Retain $name $response
    $xml = [Xml.XmlDocument]::new(); $xml.XmlResolver = $null
    $xml.LoadXml([Text.Encoding]::UTF8.GetString($response.content))
    if ($xml.DocumentElement.LocalName -ne 'ListBucketResult') { throw 'Unexpected S3 metadata document' }
    return @{ xml=$xml; proof=$proof }
}
function Json-Bytes($value) {
    return [Text.Encoding]::UTF8.GetBytes(($value | ConvertTo-Json -Depth 40) + "`n")
}
try {
    $objects = [Collections.Generic.List[object]]::new(); $token = ''; $page = 0
    do {
        $page++; if ($page -gt 8) { throw 'Bulk listing exceeds the bounded catalog page allowance' }
        $listing = Listing 'bulk-data/' ('bulk-data-list-{0:d3}.xml' -f $page) $token
        foreach ($entry in $listing.xml.ListBucketResult.Contents) {
            $objects.Add([pscustomobject][ordered]@{ key=[string]$entry.Key; last_modified=[string]$entry.LastModified; bytes=[long]$entry.Size; etag=[string]$entry.ETag; storage_class=[string]$entry.StorageClass })
        }
        $token = [string]$listing.xml.ListBucketResult.NextContinuationToken
        if ([string]$listing.xml.ListBucketResult.IsTruncated -eq 'true' -and -not $token) { throw 'Truncated listing without a continuation token' }
    } while ($token)
    $latest = @{}
    foreach ($entry in $objects) {
        if ($entry.key -match '^bulk-data/([^/]+)-(\d{4}-\d{2}-\d{2})\.(csv\.bz2|sql|sh)$') {
            $family=$Matches[1]; $date=$Matches[2]; $extension=$Matches[3]; $key="$family.$extension"
            if (-not $latest.ContainsKey($key) -or $latest[$key].snapshot -lt $date) {
                $latest[$key] = [pscustomobject][ordered]@{ family=$family; snapshot=$date; extension=$extension; key=$entry.key; bytes=$entry.bytes; etag=$entry.etag; last_modified=$entry.last_modified; url=($base+$entry.key) }
            }
        }
    }
    $csvs = @($latest.Values | Where-Object extension -eq 'csv.bz2' | Sort-Object family)
    if ($csvs.Count -ne 33) { throw "Review required: expected the researched 33 quarterly tables; got $($csvs.Count)" }
    $dates = @($csvs | Select-Object -ExpandProperty snapshot -Unique)
    if ($dates.Count -ne 1) { throw 'Latest table files do not share one completed snapshot date' }
    $snapshot = $dates[0]
    foreach ($family in @('schema.sql','load-bulk-data.sh')) {
        $artifact = $latest[$family]
        if (-not $artifact -or $artifact.snapshot -ne $snapshot) { throw "Missing matching dated schema/import metadata: $family" }
        $response = Fetch $artifact.url
        if ($response.status -ne 200 -or $response.content.Length -ne $artifact.bytes -or $response.etag -ne $artifact.etag) { throw "Schema/import identity mismatch: $family" }
        $null = Retain ($artifact.key.Substring('bulk-data/'.Length)) $response
    }
    $importText = [Text.Encoding]::UTF8.GetString($payloads["load-bulk-data-$snapshot.sh"])
    $schemaText = [Text.Encoding]::UTF8.GetString($payloads["schema-$snapshot.sql"])
    $imports = @{}
    foreach ($match in [regex]::Matches($importText, "\\COPY public\.(\w+)\s*\((.*?)\) FROM '([^']+)' WITH", [Text.RegularExpressions.RegexOptions]::Singleline)) {
        $filename = $match.Groups[3].Value.Split('/')[-1] + '.bz2'
        $imports[$filename] = @{ table=$match.Groups[1].Value; columns=@([regex]::Matches($match.Groups[2].Value, '[a-zA-Z_][a-zA-Z_0-9]*') | ForEach-Object Value) }
    }
    if ($imports.Count -ne $csvs.Count) { throw 'Dated import metadata does not describe every latest CSV' }
    $foreignKeys = @([regex]::Matches($schemaText, 'ALTER TABLE ONLY public\.(\w+)\s+ADD CONSTRAINT \S+ FOREIGN KEY \((\w+)\) REFERENCES public\.(\w+)\((\w+)\)') | ForEach-Object {
        [ordered]@{ table=$_.Groups[1].Value; column=$_.Groups[2].Value; target_table=$_.Groups[3].Value; target_column=$_.Groups[4].Value }
    })
    $localReceiptPath = Join-Path $root 'benchmarks/local-data/courtlistener-renditions/metadata/source/source.json'
    $localReceiptBytes = [IO.File]::ReadAllBytes($localReceiptPath)
    $localReceipt = [Text.Encoding]::UTF8.GetString($localReceiptBytes) | ConvertFrom-Json
    $localReceiptProof = [ordered]@{ path='benchmarks/local-data/courtlistener-renditions/metadata/source/source.json'; bytes=$localReceiptBytes.Length; sha256=(Hash-Bytes $localReceiptBytes); scope='Existing retained-source hashes by reference; CSV bodies were not rehashed or inspected by this acquisition.' }
    $tables = [Collections.Generic.List[object]]::new()
    foreach ($csv in $csvs) {
        $filename = $csv.key.Substring('bulk-data/'.Length); $definition = $imports[$filename]
        if (-not $definition) { throw "No import metadata for $filename" }
        $head = Fetch $csv.url 0 'HEAD'
        if ($head.status -ne 200 -or $head.content_length -ne $csv.bytes -or $head.etag -ne $csv.etag) { throw "Pinned object HEAD mismatch: $filename" }
        $local = $null; $retained = $localReceipt.PSObject.Properties[$csv.family]
        if ($retained -and $retained.Value.url -eq $csv.url) {
            $ref=$retained.Value; $path=Join-Path (Split-Path $localReceiptPath) $ref.path
            if (-not [IO.File]::Exists($path) -or (Get-Item -LiteralPath $path).Length -ne $csv.bytes -or $ref.etag -ne $csv.etag -or $ref.sha256 -notmatch '^[a-f0-9]{64}$') { throw "Retained local reference mismatch: $filename" }
            $local = [ordered]@{ path=('benchmarks/local-data/courtlistener-renditions/metadata/source/'+$ref.path); bytes=$ref.bytes; sha256=$ref.sha256; source_receipt=$localReceiptProof; hash_scope='Known original compressed CSV hash from the existing source receipt; no body re-read.' }
        }
        $joins = @($foreignKeys | Where-Object { $_.table -eq $definition.table -and $definition.columns -contains $_.column } | ForEach-Object {
            [ordered]@{ column=$_.column; target_table=$_.target_table; target_column=$_.target_column; target_has_quarterly_csv=($imports.Values.table -contains $_.target_table) }
        })
        $tables.Add([pscustomobject][ordered]@{ family=$csv.family; file=$filename; url=$csv.url; key=$csv.key; snapshot=$snapshot; bytes=$csv.bytes; etag=$csv.etag; last_modified=$csv.last_modified; table=$definition.table; columns=$definition.columns; joins=$joins; public_head=[ordered]@{ status=$head.status; content_length=$head.content_length; etag=$head.etag }; local_retained=$local; bulk_body_read_by_this_acquisition=$false; prior_complete_stream=$null })
    }
    $opinionProofPath = 'benchmarks/local-data/courtlistener-renditions/whole-corpus-census/full-snapshot-v2/transport-proof.json'
    $opinionProofBytes = [IO.File]::ReadAllBytes((Join-Path $root $opinionProofPath))
    $opinionProof = [Text.Encoding]::UTF8.GetString($opinionProofBytes) | ConvertFrom-Json
    $opinionObject = @($tables | Where-Object family -eq 'opinions')[0]
    if ($opinionProof.source.url -eq $opinionObject.url -and $opinionProof.source.etag -eq $opinionObject.etag -and $opinionProof.compressed_bytes -eq $opinionObject.bytes) {
        $opinionObject.prior_complete_stream = [ordered]@{ proof_path=$opinionProofPath; proof_bytes=$opinionProofBytes.Length; proof_sha256=(Hash-Bytes $opinionProofBytes); compressed_bytes=$opinionProof.compressed_bytes; compressed_sha256=$opinionProof.compressed_sha256; decoded_bytes=$opinionProof.decoded_bytes; decoded_sha256=$opinionProof.decoded_sha256; source_rows=$opinionProof.source_rows; scope='Historical completed source stream by receipt; not a newly downloaded or locally retained complete bulk object.' }
    }
    $apiResponse = Fetch 'https://www.courtlistener.com/api/rest/v4/' 262144
    if ($apiResponse.status -ne 200) { throw 'Public API root listing unavailable' }
    $apiProof = Retain 'api-root.json' $apiResponse
    $apiRoot = [Text.Encoding]::UTF8.GetString($apiResponse.content) | ConvertFrom-Json
    $models = Listing 'embeddings/opinions/freelawproject/' 'embedding-models-list.xml' '' '/'
    $modelPrefixes = @($models.xml.ListBucketResult.CommonPrefixes | ForEach-Object { [string]$_.Prefix })
    $inventoryRoot = Listing 'embeddings/inventories/com-courtlistener-storage/embeddings/' 'embedding-inventory-dates-list.xml' '' '/'
    $inventoryDates = @($inventoryRoot.xml.ListBucketResult.CommonPrefixes | ForEach-Object { [string]$_.Prefix } | Where-Object { $_ -match '/\d{4}-\d{2}-\d{2}T\d{2}-\d{2}Z/$' } | Sort-Object)
    if ([string]$models.xml.ListBucketResult.IsTruncated -eq 'true' -or [string]$inventoryRoot.xml.ListBucketResult.IsTruncated -eq 'true' -or $inventoryDates.Count -eq 0) { throw 'Embedding collection metadata is incomplete' }
    $latestInventory = Listing $inventoryDates[-1] 'embedding-latest-inventory-list.xml'
    $manifestEntry = @($latestInventory.xml.ListBucketResult.Contents | Where-Object { [string]$_.Key -match '/manifest\.json$' })[0]
    if (-not $manifestEntry) { throw 'Latest inventory directory lacks manifest metadata' }
    $manifestResponse = Fetch ($base+[string]$manifestEntry.Key) 262144
    $manifestProof = Retain ('embedding-inventory-manifest-response.'+$(if ($manifestResponse.status -eq 200) {'json'} else {'xml'})) $manifestResponse
    $embedding = [ordered]@{ model_prefixes=$modelPrefixes; latest_inventory_prefix=$inventoryDates[-1]; manifest_key=[string]$manifestEntry.Key; manifest_catalog_bytes=[long]$manifestEntry.Size; manifest_response=$manifestProof; inventory_data_read=$false; embedding_vector_bytes_read=$false; complete_vector_catalog_inspected=$false; scope='Collection-directory and latest-manifest metadata only. An HTTP 403 manifest response is retained as an access failure, not inventory contents.' }
    $boundaries = @(
        @{ collection='RECAP'; quarterly_csv='Docket case metadata, originating court information, imported FJC IDB only.'; absent_from_quarterly_csv=@('search_docketentry','search_recapdocument','people_db_party','people_db_attorney','people_db_partytype','people_db_role','people_db_criminalcount','people_db_criminalcomplaint','people_db_attorneyorganization','people_db_attorneyorganizationassociation','search_bankruptcyinformation','search_docket_panel'); access=@('https://www.courtlistener.com/api/rest/v4/docket-entries/','https://www.courtlistener.com/api/rest/v4/recap-documents/','https://www.courtlistener.com/api/rest/v4/parties/','https://www.courtlistener.com/api/rest/v4/attorneys/','https://www.courtlistener.com/api/rest/v4/bankruptcy-information/'); relation='court -> docket -> docket entry -> RECAP document; party/attorney roles are case-specific.'; body_boundary='Docket CSV contains neither entry rows nor RECAP extracted plain_text nor document bytes. Use is_available and filepath_local per actual document; descriptions do not establish body availability.'; documentation='https://wiki.free.law/c/courtlistener/help/api/rest/v4/pacer-data' },
        @{ collection='Oral arguments'; quarterly_csv='audio_audio includes stt_transcript, stt_status, stt_source and audio file locators.'; absent_from_quarterly_csv=@('audio_audio_panel','audio_audiotranscriptionmetadata'); access=@('https://www.courtlistener.com/api/rest/v4/audio/'); relation='audio.docket_id -> docket; normalized panel relation is separate and is not in the audio CSV.'; body_boundary='CSV holds machine speech-to-text, when present, not guaranteed official court transcripts. Original/enhanced audio and word/segment JSON metadata are separate; no audio was read.'; documentation=@('https://wiki.free.law/c/courtlistener/help/api/rest/v4/oral-arguments','https://github.com/freelawproject/courtlistener/blob/main/cl/audio/models.py') },
        @{ collection='Financial disclosures'; quarterly_csv='One document metadata table and eight extracted-section tables, including addendum_content_raw.'; absent_from_quarterly_csv=@('Normalized PDF bytes','Original PDF/TIFF/split-page bytes','Thumbnail bytes'); access=@('https://www.courtlistener.com/api/rest/v4/financial-disclosures/','https://www.courtlistener.com/api/rest/v4/investments/','https://www.courtlistener.com/api/rest/v4/disclosure-positions/','https://www.courtlistener.com/api/rest/v4/agreements/','https://www.courtlistener.com/api/rest/v4/non-investment-incomes/','https://www.courtlistener.com/api/rest/v4/spouse-incomes/','https://www.courtlistener.com/api/rest/v4/reimbursements/','https://www.courtlistener.com/api/rest/v4/gifts/','https://www.courtlistener.com/api/rest/v4/debts/'); relation='Section.financial_disclosure_id -> disclosure; disclosure.person_id -> people.'; body_boundary='filepath locates normalized PDF; download_filepath refers to original AWS source and may name only page one of split TIFFs. Extracted rows are not raw forms; retain redactions and inferred-value flags. No forms were read.'; documentation=@('https://wiki.free.law/c/courtlistener/help/api/rest/v4/financial-disclosures','https://wiki.free.law/c/courtlistener/help/data-coverage/judicial-financial-disclosures','https://github.com/freelawproject/courtlistener/blob/main/cl/disclosures/models.py') },
        @{ collection='Judicial records'; quarterly_csv='People, schools, positions, retention events, education, political affiliation, race vocabulary and person/race join.'; absent_from_quarterly_csv=@('people_db_source','people_db_abarating','Judge photos','Underlying biographical source-document bytes'); access=@('https://www.courtlistener.com/api/rest/v4/sources/','https://www.courtlistener.com/api/rest/v4/aba-ratings/'); relation='Sources and ABA ratings associate with people; person-specific histories join through person_id.'; body_boundary='Biographical rows, source URLs and ratings do not contain all underlying source documents.'; documentation='https://wiki.free.law/c/courtlistener/help/api/rest/v4/rest-api-v47' },
        @{ collection='Case-law supporting relations'; quarterly_csv='Citation map, citations, unmatched citations, parentheticals, panel/nonparticipant/joined-by relations.'; absent_from_quarterly_csv=@('search_parentheticalgroup','search_clusterredirection','Complete original opinion PDF bytes'); access=@('https://www.courtlistener.com/api/rest/v4/opinions-cited/','https://www.courtlistener.com/api/rest/v4/clusters/'); relation='Opinion -> cluster -> docket -> court; citation edges connect opinions. Parenthetical group_id references a group table without a quarterly CSV.'; body_boundary='Corpus opinion text and source markup remain distinct from original PDF bytes. Parentheticals have bulk export but no current parenthetical API.'; documentation=@('https://wiki.free.law/c/courtlistener/help/api/rest/v4/case-law','https://wiki.free.law/c/courtlistener/help/api/rest/opinion-cluster-redirections') },
        @{ collection='Public user collections and service endpoints'; quarterly_csv='None'; absent_from_quarterly_csv=@('Published tags/docket-tag links','Published visualization graphs','Private user data'); access=@('https://www.courtlistener.com/api/rest/v4/tags/','https://www.courtlistener.com/api/rest/v4/docket-tags/','https://www.courtlistener.com/api/rest/v4/visualizations/'); body_boundary='Published tags and visualizations are user-created collections. API-root upload, fetch, prayers, alert, membership, scraper, citation-lookup and usage routes are services or account resources, not additional full public bulk legal tables. No mutations were made.'; documentation=@('https://wiki.free.law/c/courtlistener/help/api/rest/v4/tags','https://wiki.free.law/c/courtlistener/help/api/rest/v4/visualizations') },
        @{ collection='Database replication'; quarterly_csv='Separate arranged service, not another publicly downloadable complete snapshot.'; access=@('https://wiki.free.law/c/courtlistener/help/api/replication/database-replication-for-organizations-and-researchers'); body_boundary='Live table replicas can cover case law, RECAP, FJC IDB, oral arguments, disclosures and judge/appointer data. Binary documents remain separate object-storage resources; no replica or arrangement was requested.' }
    )
    $extraObjects = @($objects | Where-Object { $_.key -match '^bulk-data/.+/' })
    $nonOpinionBytes = [long](($tables | Where-Object family -ne 'opinions' | Measure-Object bytes -Sum).Sum)
    $retainedBytes = [long](($tables | Where-Object { $_.local_retained } | Measure-Object bytes -Sum).Sum)
    $catalog = [ordered]@{ schema='courtlistener.all-collections-source-catalog.v1'; captured_utc=$captured; scope='Official public catalog metadata only; no bulk CSV, PDF, audio or embedding-vector bodies acquired.'; snapshot=$snapshot; listing_complete=$true; listing_pages=$page; listing_objects=$objects.Count; originals=$originals; csv_tables=$tables; special_catalog_objects=$extraObjects; special_catalog_scope='File names, sizes and modification dates only. Archive schemas, dataset extent and body contents were not inspected; modification time is not a content snapshot date.'; api_root_original=$apiProof; api_root=$apiRoot; embeddings=$embedding; coverage_boundaries=$boundaries; retained_local_metadata_receipt=$localReceiptProof; totals=[ordered]@{ csv_tables=$tables.Count; non_opinion_csv_tables=($tables.Count-1); all_csv_compressed_bytes=[long](($tables | Measure-Object bytes -Sum).Sum); non_opinion_csv_compressed_bytes=$nonOpinionBytes; retained_four_metadata_compressed_bytes=$retainedBytes; missing_non_opinion_csv_tables=@($tables | Where-Object { $_.family -ne 'opinions' -and -not $_.local_retained }).Count; missing_non_opinion_csv_compressed_bytes=($nonOpinionBytes-$retainedBytes) }; reproduction='Use the existing budget.py writer + require_bytes(4410358784), set the matching writer/required-byte environment, and execute this script from the repository root.' }
    $scriptBytes = [IO.File]::ReadAllBytes($PSCommandPath)
    $catalog['acquisition_script'] = [ordered]@{ path='experiments/courtlistener-renditions/inventory-sources.ps1'; bytes=$scriptBytes.Length; sha256=(Hash-Bytes $scriptBytes) }
    $payloads['catalog.json'] = Json-Bytes $catalog
    $matrix = [Text.StringBuilder]::new()
    $null = $matrix.AppendLine("The latest complete quarterly catalog is ${snapshot}: 33 CSV tables, including opinions. Every CSV descriptor has a current HTTP HEAD/ETag/size proof. No CSV or binary document body was acquired by this catalog script.")
    $null = $matrix.AppendLine()
    $null = $matrix.AppendLine('Exact ordered CSV columns are in catalog.json and the retained dated import script. Full SQL schema and foreign-key constraints are in the retained dated schema.sql; schema definitions alone do not establish exported row availability.')
    $null = $matrix.AppendLine()
    $null = $matrix.AppendLine('| File | Table | Columns | Compressed bytes | Local complete bulk file |')
    $null = $matrix.AppendLine('| --- | --- | ---: | ---: | --- |')
    foreach ($table in $tables) {
        $local = $(if ($table.local_retained) {'Retained, existing SHA reference'} elseif ($table.family -eq 'opinions') {'Historical complete stream receipt; not retained bulk object'} else {'Absent from checked local catalog'})
        $null = $matrix.AppendLine("| [$($table.file)]($($table.url)) | $($table.table) | $($table.columns.Count) | $($table.bytes) | $local |")
    }
    $null = $matrix.AppendLine()
    $null = $matrix.AppendLine('The 32 non-opinion CSVs total '+$nonOpinionBytes+' compressed bytes. Four retained metadata originals total '+$retainedBytes+' bytes; the 28 missing CSVs total '+($nonOpinionBytes-$retainedBytes)+' bytes. Decoded sizes have not been measured here.')
    $null = $matrix.AppendLine()
    $null = $matrix.AppendLine('| Collection | Quarterly CSV coverage | Access and body boundary |')
    $null = $matrix.AppendLine('| --- | --- | --- |')
    foreach ($boundary in $boundaries) {
        $links = (@($boundary.access) | ForEach-Object { "[$_]($_)" }) -join ', '
        $null = $matrix.AppendLine("| $($boundary.collection) | $($boundary.quarterly_csv) | $($boundary.body_boundary) $links |")
    }
    $null = $matrix.AppendLine()
    $null = $matrix.AppendLine('Embedding model directories and latest inventory-directory originals are retained. The latest inventory manifest response is HTTP '+$manifestResponse.status+'. Vectors and inventory data files were not read. Special archives under bulk-data/randoms and bulk-data/eyecite remain catalog-only, with their actual names/bytes/modification times in catalog.json; no schema or completeness claim follows from those names.')
    $null = $matrix.AppendLine()
    $null = $matrix.AppendLine('The acquisition script is experiments/courtlistener-renditions/inventory-sources.ps1. Run it only inside the existing budget.py writer(), holding require_bytes(4410358784) and the matching COURTLISTENER_BUDGET_WRITER=1 / COURTLISTENER_REQUIRED_BYTES environment through the process. Raw originals and their digests are in this private durable owner, not scratch storage.')
    $payloads['README.md'] = [Text.Encoding]::UTF8.GetBytes($matrix.ToString())
    $totalBytes = [long](($payloads.Values | ForEach-Object Length | Measure-Object -Sum).Sum)
    if ($totalBytes -gt 4194304) { throw 'Catalog metadata exceeds this owner allocation' }
    [IO.Directory]::CreateDirectory($owner) | Out-Null
    foreach ($name in $payloads.Keys) { [IO.File]::WriteAllBytes((Join-Path $owner $name), $payloads[$name]) }
    [ordered]@{ status='captured'; snapshot=$snapshot; tables=$tables.Count; listing_pages=$page; listing_objects=$objects.Count; catalog_bytes=$totalBytes; catalog_sha256=(Hash-Bytes $payloads['catalog.json']); embedding_manifest_status=$manifestResponse.status; bulk_or_binary_body_downloads=0 } | ConvertTo-Json
} finally { $client.Dispose() }
