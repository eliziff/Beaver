import { TRView } from "@/app/components/tabular/TabularReviewView";
export default async function ProjectTabularReviewPage({
    params,
}: { params: Promise<{ id: string; reviewId: string }> }) {
    const { id, reviewId } = await params;
    return <TRView reviewId={reviewId} projectId={id} />;
}
