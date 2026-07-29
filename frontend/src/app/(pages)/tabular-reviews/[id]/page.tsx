import { TRView } from "@/app/components/tabular/TabularReviewView";
export default async function TabularReviewPage({
    params,
}: { params: Promise<{ id: string }> }) {
    const { id } = await params;
    return <TRView reviewId={id} />;
}
