Rails.application.routes.draw do
  root "pages#home"

  get "/about", to: "pages#about"
  post "/contact", to: "pages#contact"

  resources :users do
    resources :posts
  end

  namespace :api do
    resources :users
    resources :posts
  end
end
