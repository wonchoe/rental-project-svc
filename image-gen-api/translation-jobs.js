import fs from 'fs';
import path from 'path';

const JOBS_FILE = path.join(process.cwd(), 'translation-jobs.json');
const JOB_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes timeout for stuck jobs
const JOB_EXPIRE_MS = 24 * 60 * 60 * 1000; // 24 hours to keep completed jobs

// In-memory cache synced with file
let jobsCache = {};

// Load jobs from file on startup
function loadJobs() {
    try {
        if (fs.existsSync(JOBS_FILE)) {
            const data = fs.readFileSync(JOBS_FILE, 'utf8');
            jobsCache = JSON.parse(data);
            console.log(`📂 Loaded ${Object.keys(jobsCache).length} translation jobs from disk`);
        }
    } catch (err) {
        console.error('❌ Failed to load jobs file:', err.message);
        jobsCache = {};
    }
}

// Save jobs to file
function saveJobs() {
    try {
        fs.writeFileSync(JOBS_FILE, JSON.stringify(jobsCache, null, 2));
    } catch (err) {
        console.error('❌ Failed to save jobs file:', err.message);
    }
}

// Generate unique job ID
function generateJobId() {
    return `job_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

// Default batch size (can be changed in real-time)
const DEFAULT_BATCH_SIZE = 50;

// Create new job - files can be without content (queued) or with content (pending)
export function createJob(siteId, domain, files, batchSize = DEFAULT_BATCH_SIZE) {
    const jobId = generateJobId();
    
    const job = {
        id: jobId,
        siteId,
        domain,
        status: 'pending', // pending, processing, completed, failed, stopped
        createdAt: Date.now(),
        updatedAt: Date.now(),
        startedAt: null,
        completedAt: null,
        totalFiles: files.length,
        completedFiles: 0,
        failedFiles: 0,
        currentBatch: 0,
        batchSize: batchSize, // Configurable batch size (threads)
        totalBatches: Math.ceil(files.length / batchSize),
        files: files.map(f => ({
            path: f.path,
            lang: f.lang,
            content: f.content || null,
            // queued = no content yet, pending = has content ready to translate
            status: f.content ? 'pending' : 'queued',
            error: null,
            translated: null,
            downloaded: false, // Track if Laravel has downloaded this file
        })),
        error: null,
    };
    
    jobsCache[jobId] = job;
    saveJobs();
    
    console.log(`📝 Created job ${jobId} for ${domain} with ${files.length} files`);
    return job;
}

// Add content to queued files
export function addContentToFiles(jobId, filesWithContent) {
    const job = jobsCache[jobId];
    if (!job) return null;
    
    let added = 0;
    for (const incoming of filesWithContent) {
        const file = job.files.find(f => 
            f.path === incoming.path && 
            f.lang === incoming.lang && 
            f.status === 'queued'
        );
        if (file && incoming.content) {
            file.content = incoming.content;
            file.status = 'pending';
            added++;
        }
    }
    
    job.updatedAt = Date.now();
    saveJobs();
    
    console.log(`📥 Job ${jobId}: Added content to ${added} files`);
    return { added, job };
}

// Get queued files count (waiting for content)
export function getQueuedFilesCount(jobId) {
    const job = jobsCache[jobId];
    if (!job) return 0;
    return job.files.filter(f => f.status === 'queued').length;
}

// Get files that need content (for frontend to load)
export function getFilesNeedingContent(jobId, limit) {
    const job = jobsCache[jobId];
    if (!job) return [];
    
    return job.files
        .filter(f => f.status === 'queued')
        .slice(0, limit)
        .map(f => ({ path: f.path, lang: f.lang }));
}

// Get job by ID
export function getJob(jobId) {
    return jobsCache[jobId] || null;
}

// Get active job for site
export function getActiveJobForSite(siteId) {
    return Object.values(jobsCache).find(job => 
        job.siteId === siteId && 
        (job.status === 'pending' || job.status === 'processing' || job.status === 'batch_uploading' || job.status === 'batch_submitted')
    ) || null;
}

// Update job
export function updateJob(jobId, updates) {
    if (!jobsCache[jobId]) return null;
    
    const prevStatus = jobsCache[jobId].status;
    jobsCache[jobId] = {
        ...jobsCache[jobId],
        ...updates,
        updatedAt: Date.now(),
    };
    if (updates.status && updates.status !== prevStatus) {
        console.log(`🔄 Job ${jobId}: ${prevStatus} → ${updates.status}`);
    }
    saveJobs();
    return jobsCache[jobId];
}

// Update file status in job
export function updateFileStatus(jobId, filePath, lang, status, extra = {}) {
    const job = jobsCache[jobId];
    if (!job) return null;
    
    const fileIndex = job.files.findIndex(f => f.path === filePath && f.lang === lang);
    if (fileIndex === -1) return null;
    
    job.files[fileIndex] = {
        ...job.files[fileIndex],
        status,
        ...extra,
    };
    
    // Recalculate stats
    job.completedFiles = job.files.filter(f => f.status === 'completed' || f.status === 'skipped').length;
    job.failedFiles = job.files.filter(f => f.status === 'failed' || f.status === 'validation_failed').length;
    job.updatedAt = Date.now();
    
    // Check if job is complete
    const pendingOrProcessing = job.files.filter(f => f.status === 'pending' || f.status === 'processing').length;
    if (pendingOrProcessing === 0 && job.status === 'processing') {
        job.status = job.failedFiles > 0 ? 'completed_with_errors' : 'completed';
        job.completedAt = Date.now();
        console.log(`✅ Job ${jobId} completed: ${job.completedFiles} success, ${job.failedFiles} failed`);
    }
    
    saveJobs();
    return job;
}

// Stop job
export function stopJob(jobId) {
    const job = jobsCache[jobId];
    if (!job) return null;
    
    job.status = 'stopped';
    job.updatedAt = Date.now();
    
    // Mark processing files as pending (so they can be retried)
    job.files.forEach(f => {
        if (f.status === 'processing') {
            f.status = 'pending';
        }
    });
    
    saveJobs();
    console.log(`🛑 Job ${jobId} stopped`);
    return job;
}

// Resume job (create new job with pending files from old job)
export function resumeJob(jobId) {
    const oldJob = jobsCache[jobId];
    if (!oldJob) return null;
    
    const pendingFiles = oldJob.files.filter(f => 
        f.status === 'pending' || f.status === 'failed' || f.status === 'processing'
    );
    
    if (pendingFiles.length === 0) {
        return null; // Nothing to resume
    }
    
    // Mark old job as resumed
    oldJob.status = 'resumed';
    oldJob.updatedAt = Date.now();
    
    // Create new job with pending files
    const newJob = createJob(oldJob.siteId, oldJob.domain, pendingFiles);
    
    console.log(`🔄 Resumed job ${jobId} as ${newJob.id} with ${pendingFiles.length} files`);
    return newJob;
}

// Clean up old/stuck jobs
export function cleanupJobs() {
    const now = Date.now();
    let cleaned = 0;
    let unstuck = 0;
    
    Object.keys(jobsCache).forEach(jobId => {
        const job = jobsCache[jobId];
        
        // Delete expired completed/failed jobs
        if (['completed', 'completed_with_errors', 'failed', 'stopped', 'resumed'].includes(job.status)) {
            if (now - job.updatedAt > JOB_EXPIRE_MS) {
                delete jobsCache[jobId];
                cleaned++;
            }
        }
        
        // Unstick processing jobs that haven't been updated
        if (job.status === 'processing' && now - job.updatedAt > JOB_TIMEOUT_MS) {
            job.status = 'stuck';
            job.error = 'Job timed out - no updates for 5 minutes';
            job.files.forEach(f => {
                if (f.status === 'processing') {
                    f.status = 'pending';
                    f.error = 'Timed out';
                }
            });
            unstuck++;
        }
    });
    
    if (cleaned > 0 || unstuck > 0) {
        saveJobs();
        console.log(`🧹 Cleanup: ${cleaned} expired, ${unstuck} unstuck`);
    }
}

// Get job summary for UI
export function getJobSummary(jobId) {
    const job = jobsCache[jobId];
    if (!job) return null;
    
    // Count downloaded files
    const downloadedFiles = job.files.filter(f => f.downloaded).length;
    
    return {
        id: job.id,
        siteId: job.siteId,
        domain: job.domain,
        mode: job.mode || 'realtime',
        status: job.status,
        createdAt: job.createdAt,
        updatedAt: job.updatedAt,
        startedAt: job.startedAt,
        completedAt: job.completedAt,
        totalFiles: job.totalFiles,
        completedFiles: job.completedFiles,
        failedFiles: job.failedFiles,
        downloadedFiles: downloadedFiles,
        queuedFiles: job.files.filter(f => f.status === 'queued').length,
        pendingFiles: job.files.filter(f => f.status === 'pending').length,
        processingFiles: job.files.filter(f => f.status === 'processing').length,
        batchSize: job.batchSize || 50,
        currentBatch: job.currentBatch,
        totalBatches: job.totalBatches,
        error: job.error,
        // Batch API fields
        batchApiId: job.batchApiId || null,
        batchApiStatus: job.batchApiStatus || null,
        batchRequestCounts: job.batchRequestCounts || null,
        batchModel: job.batchModel || null,
        batchProvider: job.batchProvider || null,
        retriesLeft: job.retriesLeft ?? null,
        validationFailedFiles: job.mode === 'batch'
            ? job.files.filter(f => f.status === 'validation_failed').length : 0,
        files: job.files.map(f => ({
            path: f.path,
            lang: f.lang,
            status: f.status,
            error: f.error,
            downloaded: f.downloaded,
        })),
    };
}

// Get files ready for download (translated but not yet downloaded)
export function getFilesReadyForDownload(jobId) {
    const job = jobsCache[jobId];
    if (!job) return [];
    
    return job.files
        .filter(f => (f.status === 'completed' || f.status === 'skipped') && !f.downloaded && f.translated)
        .map((f, index) => ({
            index: job.files.indexOf(f),
            path: f.path,
            lang: f.lang,
            status: f.status,
        }));
}

// Update batch size for a job (real-time control)
export function updateBatchSize(jobId, newBatchSize) {
    const job = jobsCache[jobId];
    if (!job) return null;
    
    const oldSize = job.batchSize || DEFAULT_BATCH_SIZE;
    job.batchSize = Math.max(1, Math.min(100, newBatchSize)); // Clamp 1-100
    job.updatedAt = Date.now();
    
    // Recalculate total batches based on remaining pending files
    const pendingFiles = job.files.filter(f => f.status === 'pending').length;
    if (pendingFiles > 0) {
        job.totalBatches = job.currentBatch + Math.ceil(pendingFiles / job.batchSize);
    }
    
    saveJobs();
    console.log(`⚙️ Job ${jobId}: batch size changed ${oldSize} → ${job.batchSize}`);
    return job;
}

// Get current batch size for a job
export function getBatchSize(jobId) {
    const job = jobsCache[jobId];
    return job?.batchSize || DEFAULT_BATCH_SIZE;
}

// Mark file as downloaded
export function markFileDownloaded(jobId, fileIndex) {
    const job = jobsCache[jobId];
    if (!job || !job.files[fileIndex]) return null;
    
    job.files[fileIndex].downloaded = true;
    job.updatedAt = Date.now();
    saveJobs();
    
    console.log(`📥 Marked file ${fileIndex} as downloaded in job ${jobId}`);
    return job;
}

// Get download stats for a job
export function getDownloadStats(jobId) {
    const job = jobsCache[jobId];
    if (!job) return null;
    
    const completed = job.files.filter(f => f.status === 'completed' || f.status === 'skipped');
    const downloaded = completed.filter(f => f.downloaded);
    const pending = completed.filter(f => !f.downloaded && f.translated);
    
    return {
        totalCompleted: completed.length,
        downloaded: downloaded.length,
        pendingDownload: pending.length,
    };
}

// ─── Batch API Job Functions ───────────────────────────────────

// Create a batch API job (all files must have content upfront)
export function createBatchJob(siteId, domain, files, model = 'gpt-4o-mini') {
    const jobId = generateJobId();
    
    const job = {
        id: jobId,
        siteId,
        domain,
        mode: 'batch', // 'batch' vs 'realtime'
        status: 'pending',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        startedAt: null,
        completedAt: null,
        totalFiles: files.length,
        completedFiles: 0,
        failedFiles: 0,
        currentBatch: 0,
        batchSize: files.length,
        totalBatches: 1,
        // Batch API specific
        batchApiId: null,
        batchApiStatus: null,
        batchRequestCounts: null,
        batchModel: model,
        batchProvider: String(model || '').toLowerCase().startsWith('gemini-') ? 'gemini' : 'openai',
        inputFileId: null,
        outputFileId: null,
        errorFileId: null,
        batchSubmittedAt: null,
        batchCompletedAt: null,
        retriesLeft: MAX_BATCH_RETRIES,
        files: files.map(f => ({
            path: f.path,
            lang: f.lang,
            content: f.content || null,
            status: f.content ? 'batch_queued' : 'queued',
            error: null,
            translated: null,
            downloaded: false,
            validationErrors: null,
        })),
        error: null,
    };
    
    jobsCache[jobId] = job;
    saveJobs();
    
    console.log(`📝 Created BATCH job ${jobId} for ${domain} with ${files.length} files (model: ${model})`);
    return job;
}

const MAX_BATCH_RETRIES = 2;

// Get all active batch jobs (for polling)
export function getActiveBatchJobs() {
    return Object.values(jobsCache).filter(job =>
        job.mode === 'batch' &&
        ['pending', 'processing', 'batch_uploading', 'batch_submitted'].includes(job.status)
    );
}

// Update batch API status on a job
export function updateBatchStatus(jobId, batchInfo) {
    const job = jobsCache[jobId];
    if (!job) return null;
    
    const prevStatus = job.batchApiStatus;
    if (batchInfo.batchApiId) job.batchApiId = batchInfo.batchApiId;
    if (batchInfo.status) job.batchApiStatus = batchInfo.status;
    if (batchInfo.requestCounts) job.batchRequestCounts = batchInfo.requestCounts;
    if (batchInfo.provider) job.batchProvider = batchInfo.provider;
    if (batchInfo.outputFileId) job.outputFileId = batchInfo.outputFileId;
    if (batchInfo.errorFileId) job.errorFileId = batchInfo.errorFileId;
    if (batchInfo.inputFileId) job.inputFileId = batchInfo.inputFileId;
    job.updatedAt = Date.now();
    
    if (batchInfo.status && batchInfo.status !== prevStatus) {
        console.log(`📦 [updateBatchStatus] Job ${jobId}: batch ${prevStatus} → ${batchInfo.status}`);
    }
    saveJobs();
    return job;
}

// Apply batch results to job files
export function applyBatchResults(jobId, results) {
    const job = jobsCache[jobId];
    if (!job) return null;
    
    let completed = 0, failed = 0, validationFailed = 0;
    
    for (const r of results) {
        const file = job.files[r.fileIndex];
        if (!file) continue;
        
        if (r.error) {
            file.status = 'failed';
            file.error = r.error;
            failed++;
        } else if (r.validationErrors && r.validationErrors.length > 0) {
            file.status = 'validation_failed';
            file.error = r.validationErrors.join('; ');
            file.validationErrors = r.validationErrors;
            file.translated = r.translated; // Keep it for potential manual use
            validationFailed++;
        } else {
            file.status = 'completed';
            file.translated = r.translated;
            file.error = null;
            completed++;
        }
    }
    
    job.completedFiles = job.files.filter(f => f.status === 'completed' || f.status === 'skipped').length;
    job.failedFiles = job.files.filter(f => f.status === 'failed' || f.status === 'validation_failed').length;
    job.updatedAt = Date.now();
    
    // Check if done
    const pending = job.files.filter(f =>
        ['batch_queued', 'batch_submitted', 'pending', 'processing'].includes(f.status)
    ).length;
    if (pending === 0) {
        job.status = (failed > 0 || validationFailed > 0) ? 'completed_with_errors' : 'completed';
        job.completedAt = Date.now();
        job.batchCompletedAt = Date.now();
    }
    
    saveJobs();
    console.log(`📊 Batch results applied to job ${jobId}: ${completed} ok, ${failed} failed, ${validationFailed} validation errors`);
    return { completed, failed, validationFailed };
}

// Get files that need retry (failed + validation_failed)
export function getRetryFiles(jobId) {
    const job = jobsCache[jobId];
    if (!job) return [];
    
    return job.files
        .map((f, i) => ({ ...f, fileIndex: i }))
        .filter(f => f.status === 'failed' || f.status === 'validation_failed');
}

// Reset retry files to batch_queued for re-submission
export function resetFilesForRetry(jobId) {
    const job = jobsCache[jobId];
    if (!job) return 0;
    
    let reset = 0;
    job.files.forEach(f => {
        if (f.status === 'failed' || f.status === 'validation_failed') {
            f.status = 'batch_queued';
            f.error = null;
            f.translated = null;
            f.validationErrors = null;
            reset++;
        }
    });
    
    if (reset > 0) {
        job.status = 'processing';
        job.retriesLeft = Math.max(0, (job.retriesLeft ?? MAX_BATCH_RETRIES) - 1);
        job.batchApiId = null;
        job.batchApiStatus = null;
        job.outputFileId = null;
        job.errorFileId = null;
        job.updatedAt = Date.now();
        saveJobs();
    }
    
    console.log(`🔄 Reset ${reset} files for retry in job ${jobId} (retries left: ${job.retriesLeft})`);
    return reset;
}

// Initialize on load
loadJobs();

// Run cleanup every 10 minutes
setInterval(cleanupJobs, 10 * 60 * 1000);

// Export for testing
export { jobsCache, loadJobs, saveJobs };
