"use client";

import { Bell, Plus } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

export function CreateNoteDialog() {
  const [isOpen, setIsOpen] = useState(false);

  const showPreview = () => {
    toast("Notifications will appear here.", {
      description: "This is a UI preview; no note or other data was created.",
    });
    setIsOpen(false);
  };

  return (
    <Dialog open={isOpen} onOpenChange={setIsOpen}>
      <DialogTrigger asChild>
        <Button className="gap-2">
          <Plus className="h-4 w-4" aria-hidden="true" />
          Open UI preview
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Notification preview</DialogTitle>
          <DialogDescription>
            Preview the dialog and notification primitives. This action does not create or save
            anything.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-4">
          <p className="text-sm text-muted-foreground">
            Use this preview to check keyboard focus, dismissal, and the polite notification
            announcement.
          </p>
          <div className="flex justify-end gap-2 pt-4">
            <Button variant="outline" onClick={() => setIsOpen(false)}>
              Cancel
            </Button>
            <Button onClick={showPreview} className="gap-2">
              <Bell className="h-4 w-4" aria-hidden="true" />
              Show notification
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
