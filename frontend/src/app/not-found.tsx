import { MessagePage } from "@/app/error";
export default function NotFound() {
    return <MessagePage title="Page not found" action="Go home"
        message="The page you're looking for doesn't exist or may have been moved." />;
}
