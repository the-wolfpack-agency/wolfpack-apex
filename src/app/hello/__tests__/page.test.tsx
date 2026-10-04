import { render, screen } from '@testing-library/react';
import HelloPage from '../page';

describe('HelloPage', () => {
  it('renders the hello message', () => {
    render(<HelloPage />);
    expect(screen.getByText('Hello, World!')).toBeInTheDocument();
  });
});