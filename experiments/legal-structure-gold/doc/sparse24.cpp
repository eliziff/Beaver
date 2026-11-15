// 2:4 structured-sparse matrix products on Ampere's sparse tensor cores, through NVIDIA's cuSPARSELt (which the Windows
// builds of torch do not carry): y = x · Wᵀ with W (out × in) pruned 2:4 along its inputs and compressed. W is the
// structured matrix A (out × in, row-major); x (n × in, row-major) is read as B (in × n, column-major); the product
// D (out × n, column-major) is y (n × out, row-major). One plan a shape (out, in, n), kept.
#include <torch/extension.h>
#include <c10/cuda/CUDAStream.h>
#include <cusparseLt.h>
#include <map>
#include <mutex>
#include <tuple>

#define CHECK(call)                                                                                   \
    do {                                                                                              \
        cusparseStatus_t status_ = (call);                                                            \
        TORCH_CHECK(status_ == CUSPARSE_STATUS_SUCCESS, "cuSPARSELt: ", cusparseLtGetErrorString(status_), \
                    " (", #call, ")");                                                                \
    } while (0)

namespace {

struct Plan {
    cusparseLtMatDescriptor_t a, b, d;
    cusparseLtMatmulDescriptor_t matmul;
    cusparseLtMatmulAlgSelection_t alg;
    cusparseLtMatmulPlan_t plan;
    size_t compressed = 0, buffer = 0, workspace = 0;
    bool searched = false;  // its kernel configuration chosen by timing them (cusparseLtMatmulSearch), on first use
};

cusparseLtHandle_t handle;
bool ready = false;
std::map<std::tuple<int64_t, int64_t, int64_t>, Plan*> plans;
std::mutex lock;

Plan* plan_of(int64_t out, int64_t in, int64_t n) {
    std::lock_guard<std::mutex> guard(lock);
    if (!ready) {
        CHECK(cusparseLtInit(&handle));
        ready = true;
    }
    auto key = std::make_tuple(out, in, n);
    auto found = plans.find(key);
    if (found != plans.end()) return found->second;
    auto* p = new Plan();
    const uint32_t align = 16;
    CHECK(cusparseLtStructuredDescriptorInit(&handle, &p->a, out, in, in, align, CUDA_R_16BF, CUSPARSE_ORDER_ROW,
                                             CUSPARSELT_SPARSITY_50_PERCENT));
    CHECK(cusparseLtDenseDescriptorInit(&handle, &p->b, in, n, in, align, CUDA_R_16BF, CUSPARSE_ORDER_COL));
    CHECK(cusparseLtDenseDescriptorInit(&handle, &p->d, out, n, out, align, CUDA_R_16BF, CUSPARSE_ORDER_COL));
    CHECK(cusparseLtMatmulDescriptorInit(&handle, &p->matmul, CUSPARSE_OPERATION_NON_TRANSPOSE, CUSPARSE_OPERATION_NON_TRANSPOSE,
                                         &p->a, &p->b, &p->d, &p->d, CUSPARSE_COMPUTE_32F));
    CHECK(cusparseLtMatmulAlgSelectionInit(&handle, &p->alg, &p->matmul, CUSPARSELT_MATMUL_ALG_DEFAULT));
    CHECK(cusparseLtMatmulPlanInit(&handle, &p->plan, &p->matmul, &p->alg));
    CHECK(cusparseLtSpMMACompressedSize(&handle, &p->plan, &p->compressed, &p->buffer));
    CHECK(cusparseLtMatmulGetWorkspace(&handle, &p->plan, &p->workspace));
    plans[key] = p;
    return p;
}

}  // namespace

// The bytes W's compressed form takes for the shape (out, in, n).
int64_t compressed_size(int64_t out, int64_t in, int64_t n) { return static_cast<int64_t>(plan_of(out, in, n)->compressed); }

// W (out × in, bf16, already 2:4 along its inputs) compressed for products with n rows.
torch::Tensor compress(torch::Tensor w, int64_t n) {
    TORCH_CHECK(w.is_cuda() && w.scalar_type() == torch::kBFloat16 && w.dim() == 2 && w.is_contiguous(), "W: a contiguous bf16 CUDA matrix");
    Plan* p = plan_of(w.size(0), w.size(1), n);
    auto bytes = torch::TensorOptions().dtype(torch::kUInt8).device(w.device());
    auto out = torch::empty({static_cast<int64_t>(p->compressed)}, bytes);
    auto buffer = torch::empty({static_cast<int64_t>(std::max<size_t>(p->buffer, 1))}, bytes);
    CHECK(cusparseLtSpMMACompress(&handle, &p->plan, w.data_ptr(), out.data_ptr(), buffer.data_ptr(),
                                  c10::cuda::getCurrentCUDAStream().stream()));
    return out;
}

// y = x · Wᵀ (n × out, bf16) from W's compressed form (`compress`) and x (n × in, bf16, contiguous).
torch::Tensor matmul(torch::Tensor compressed, torch::Tensor x, int64_t out_features) {
    TORCH_CHECK(x.is_cuda() && x.scalar_type() == torch::kBFloat16 && x.dim() == 2 && x.is_contiguous(), "x: a contiguous bf16 CUDA matrix");
    const int64_t n = x.size(0), in = x.size(1);
    Plan* p = plan_of(out_features, in, n);
    auto y = torch::empty({n, out_features}, x.options());
    auto workspace = torch::empty({static_cast<int64_t>(std::max<size_t>(p->workspace, 1))}, x.options().dtype(torch::kUInt8));
    float alpha = 1.0f, beta = 0.0f;
    cudaStream_t stream = c10::cuda::getCurrentCUDAStream().stream();
    if (!p->searched) {
        // The fastest of the library's kernel configurations for this shape, timed once; its workspace read again.
        CHECK(cusparseLtMatmulSearch(&handle, &p->plan, &alpha, compressed.data_ptr(), x.data_ptr(), &beta, y.data_ptr(), y.data_ptr(),
                                     workspace.data_ptr(), &stream, 1));
        CHECK(cusparseLtMatmulGetWorkspace(&handle, &p->plan, &p->workspace));
        workspace = torch::empty({static_cast<int64_t>(std::max<size_t>(p->workspace, 1))}, x.options().dtype(torch::kUInt8));
        p->searched = true;
    }
    CHECK(cusparseLtMatmul(&handle, &p->plan, &alpha, compressed.data_ptr(), x.data_ptr(), &beta, y.data_ptr(), y.data_ptr(),
                           workspace.data_ptr(), &stream, 1));
    return y;
}

PYBIND11_MODULE(TORCH_EXTENSION_NAME, m) {
    m.def("compressed_size", &compressed_size);
    m.def("compress", &compress);
    m.def("matmul", &matmul);
}
