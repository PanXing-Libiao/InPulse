import React from "react";
import { describe, expect, it } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { NotFoundPage } from "./NotFoundPage";

function LocationProbe() {
  const location = useLocation();
  return <span data-testid="probe-path">{location.pathname}</span>;
}

describe("NotFoundPage", () => {
  it("renders a branded 404 that keeps the workspace reachable", async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={["/definitely-not-a-route"]}>
        <Routes>
          <Route
            path="*"
            element={
              <>
                <NotFoundPage />
                <LocationProbe />
              </>
            }
          />
          <Route path="/tasks" element={<LocationProbe />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(screen.getByTestId("route-not-found")).toBeInTheDocument();
    expect(screen.getByText("页面不存在")).toBeInTheDocument();
    expect(screen.queryByText(/Hey developer/u)).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "回到任务中心" }));
    await waitFor(() =>
      expect(screen.getByTestId("probe-path")).toHaveTextContent("/tasks"),
    );
  });
});
